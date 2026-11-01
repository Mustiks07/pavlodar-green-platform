"""Authorized immutable-version MVT delivery from indexed PostGIS import geometry."""

import hashlib
from uuid import UUID

from fastapi import Request
from fastapi.responses import Response
from sqlalchemy import text

from packages.domain.errors import DomainError
from services.api.db import session
from services.api.security import digest


def simplification_tolerance(zoom: int) -> float:
    """One display pixel in Web Mercator metres at the requested zoom."""
    return 40075016.68557849 / (256 * 2**zoom)


# Server building height of each tile feature, the same rule as
# packages.domain.heights.record_height (ADR-004 §6): a declared height_m with a known basis is
# kept, a metric `height` tag is recorded_unverified, anything else is unknown (no height).
# Nested CASE keeps casts behind their type checks; raw height_m/height_basis are replaced.
TILE_HEIGHT_COLUMNS = """
        properties - 'height_m' - 'height_basis' AS properties,
        COALESCE(heights.declared, CASE WHEN heights.recorded > 0 THEN heights.recorded END) AS height_m,
        CASE
          WHEN heights.declared IS NOT NULL THEN properties->>'height_basis'
          WHEN heights.recorded > 0 THEN 'recorded_unverified'
          ELSE 'unknown'
        END AS height_basis"""
TILE_HEIGHT_LATERAL = r"""
      CROSS JOIN LATERAL (
        SELECT
          CASE WHEN jsonb_typeof(properties->'height_m')='number' THEN
            CASE WHEN (properties->>'height_m')::numeric > 0
                  AND (properties->>'height_m')::numeric < 1e300
                  AND properties->>'height_basis' IN
                    ('measured','recorded_unverified','floors_estimate','visual_placeholder')
              THEN (properties->>'height_m')::float8 END
          END AS declared,
          CASE
            WHEN jsonb_typeof(properties->'height')='number' THEN
              CASE WHEN (properties->>'height')::numeric < 1e300
                THEN (properties->>'height')::float8 END
            WHEN jsonb_typeof(properties->'height')='string'
              AND properties->>'height' ~* '^\s*[0-9]+([.,][0-9]+)?\s*(m|м|meters|metres)?\s*$'
              THEN replace(substring(properties->>'height' from '[0-9]+(?:[.,][0-9]+)?'), ',', '.')::float8
          END AS recorded
      ) heights"""


TILE_QUERY = text(
    """
    WITH actor AS (
      SELECT p.id AS user_id,
        CASE
          WHEN p.roles ? 'admin' THEN 2
          WHEN p.roles ? 'specialist' THEN 1
          WHEN p.roles ? 'viewer' THEN 0
          ELSE -1
        END AS role_level
      FROM web_sessions ws
      JOIN principals p ON p.id=ws.user_id
      WHERE ws.token_hash=:token_hash AND ws.expires_at>now() AND p.active
    ), scope AS (
      SELECT
        actor.role_level,
        ml.dataset_version_id,
        ml.geometry_type,
        d.access_level,
        d.current_version_id=ml.dataset_version_id AS is_current,
        EXISTS(
          SELECT 1 FROM city_grants cg
          WHERE cg.user_id=actor.user_id AND cg.city_id=d.city_id
        ) AS city_granted,
        EXISTS(
          SELECT 1 FROM dataset_grants dg
          WHERE dg.user_id=actor.user_id AND dg.dataset_id=d.id
        ) AS dataset_granted
      FROM actor
      JOIN map_layers ml ON ml.id=:layer_id
      JOIN datasets d ON d.id=ml.dataset_id
    ), decision AS (
      SELECT *, city_granted AND CASE access_level
        WHEN 'public' THEN true
        WHEN 'internal' THEN role_level>=1
        WHEN 'restricted' THEN dataset_granted
        ELSE false
      END AS allowed
      FROM scope
    ), bounds AS (
      SELECT ST_TileEnvelope(:z,:x,:y) AS geom
    ), source_rows AS (
      SELECT
        ir.row_index::bigint AS mvt_id,
        ((md5('pavlodar:map-feature:' || ir.version_id::text || ':' || ir.row_index::text))::uuid)::text AS feature_id,
        ir.payload->>'source_record_id' AS source_record_id,
        ir.payload->'properties' AS properties,
        decision.geometry_type,
        ST_Transform(ir.geometry,3857) AS geom
      FROM import_records ir CROSS JOIN bounds CROSS JOIN decision
      WHERE decision.allowed AND decision.is_current
        AND ir.version_id=decision.dataset_version_id
        AND (
          (decision.geometry_type='point' AND GeometryType(ir.geometry) IN ('POINT','MULTIPOINT'))
          OR (decision.geometry_type='line' AND GeometryType(ir.geometry) IN ('LINESTRING','MULTILINESTRING'))
          OR (decision.geometry_type='polygon' AND GeometryType(ir.geometry) IN ('POLYGON','MULTIPOLYGON'))
        )
        AND ir.geometry && ST_Transform(bounds.geom,4326)
        AND ST_Intersects(ir.geometry,ST_Transform(bounds.geom,4326))
    ), generalized_rows AS (
      SELECT
        mvt_id, feature_id, source_record_id, properties,
        CASE
          WHEN :z < 15 AND geometry_type IN ('line','polygon')
          THEN ST_SimplifyPreserveTopology(
            geom,
            :tolerance
          )
          ELSE geom
        END AS geom
      FROM source_rows
    ), tile_rows AS (
      SELECT
        mvt_id, feature_id, source_record_id,"""
    + TILE_HEIGHT_COLUMNS
    + """,
        ST_AsMVTGeom(generalized_rows.geom,bounds.geom,4096,64,true) AS geom
      FROM generalized_rows CROSS JOIN bounds"""
    + TILE_HEIGHT_LATERAL
    + """
    )
    SELECT
      EXISTS(SELECT 1 FROM actor) AS authenticated,
      COALESCE((SELECT role_level FROM actor),-1) AS role_level,
      EXISTS(SELECT 1 FROM scope) AS layer_found,
      COALESCE((SELECT city_granted FROM decision),false) AS city_granted,
      COALESCE((SELECT access_level FROM decision),'') AS access_level,
      COALESCE((SELECT allowed FROM decision),false) AS allowed,
      COALESCE((SELECT is_current FROM decision),false) AS is_current,
      (SELECT ST_AsMVT(tile_rows,'features',4096,'geom','mvt_id')
       FROM tile_rows WHERE geom IS NOT NULL) AS tile
    """
)


def parse_tile_path(request):
    try:
        layer_id = str(UUID(request.path_params["layer_id"]))
        z = int(request.path_params["z"])
        x = int(request.path_params["x"])
        y = int(request.path_params["y"])
    except (ValueError, TypeError):
        raise DomainError(422, "invalid_parameter", "Некорректный адрес тайла") from None
    if not 0 <= z <= 22 or not 0 <= x < 2**z or not 0 <= y < 2**z:
        raise DomainError(422, "invalid_parameter", "Координаты тайла вне диапазона")
    return layer_id, z, x, y


def get_map_tile(request: Request):
    layer_id, z, x, y = parse_tile_path(request)
    with session() as db:
        result = db.execute(
            TILE_QUERY,
            {
                "token_hash": digest(request.cookies.get("pavlodar_session", "")),
                "layer_id": layer_id,
                "z": z,
                "x": x,
                "y": y,
                "tolerance": simplification_tolerance(z),
            },
        ).mappings().one()
    if not result["authenticated"]:
        raise DomainError(401, "authentication_required", "Войдите, чтобы продолжить")
    if result["role_level"] < 0:
        raise DomainError(403, "role_required", "Недостаточно прав")
    if not result["layer_found"] or not result["city_granted"]:
        raise DomainError(404, "not_found", "Объект не найден")
    if not result["allowed"]:
        status = 403 if result["access_level"] == "internal" else 404
        raise DomainError(status, "role_required" if status == 403 else "not_found", "Недостаточно прав")
    if not result["is_current"]:
        raise DomainError(404, "not_found", "Слой не является текущей публикацией")
    content = bytes(result["tile"] or b"")
    etag = '"' + hashlib.sha256(content).hexdigest() + '"'
    headers = {"Cache-Control": "private, max-age=60", "ETag": etag}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(content=content, media_type="application/vnd.mapbox-vector-tile", headers=headers)
