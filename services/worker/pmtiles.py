"""Offline PMTiles v3 builder for immutable, public, published vector layers.

The request path continues to serve mutable/current layers from PostGIS. This builder is
deliberately explicit and bounded: it never silently turns a protected dataset into a
downloadable archive and never guesses an archive zoom range.
"""

from __future__ import annotations

import hashlib
import math
import os
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

from pmtiles.reader import Reader
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer
from sqlalchemy import select, text

from services.api.models import MapArchiveArtifact
from services.api.tiles import (
    TILE_HEIGHT_COLUMNS,
    TILE_HEIGHT_LATERAL,
    simplification_tolerance,
)

WEB_MERCATOR_MAX_LAT = 85.05112878
DEFAULT_MAX_CANDIDATE_TILES = 20_000


class ArchiveBuildError(RuntimeError):
    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail

LAYER_SCOPE_QUERY = text(
    """
    SELECT
      d.access_level,
      d.current_version_id=ml.dataset_version_id AS is_current,
      dv.status,
      ml.dataset_version_id,
      ml.geometry_type,
      ml.payload,
      ST_XMin(extent)::double precision AS min_lon,
      ST_YMin(extent)::double precision AS min_lat,
      ST_XMax(extent)::double precision AS max_lon,
      ST_YMax(extent)::double precision AS max_lat
    FROM map_layers ml
    JOIN datasets d ON d.id=ml.dataset_id
    JOIN dataset_versions dv ON dv.id=ml.dataset_version_id
    CROSS JOIN LATERAL (
      SELECT ST_Extent(ir.geometry) AS extent
      FROM import_records ir
      WHERE ir.version_id=ml.dataset_version_id
        AND (
          (ml.geometry_type='point' AND GeometryType(ir.geometry) IN ('POINT','MULTIPOINT'))
          OR (ml.geometry_type='line' AND GeometryType(ir.geometry) IN ('LINESTRING','MULTILINESTRING'))
          OR (ml.geometry_type='polygon' AND GeometryType(ir.geometry) IN ('POLYGON','MULTIPOLYGON'))
        )
    ) bounds
    WHERE ml.id=:layer_id AND extent IS NOT NULL
    """
)

ARCHIVE_TILE_QUERY = text(
    """
    WITH layer_scope AS (
      SELECT ml.dataset_version_id, ml.geometry_type
      FROM map_layers ml
      JOIN datasets d ON d.id=ml.dataset_id
      JOIN dataset_versions dv ON dv.id=ml.dataset_version_id
      WHERE ml.id=:layer_id
        AND d.access_level='public'
        AND d.current_version_id=ml.dataset_version_id
        AND dv.status='published'
    ), bounds AS (
      SELECT ST_TileEnvelope(:z,:x,:y) AS geom
    ), source_rows AS (
      SELECT
        ir.row_index::bigint AS mvt_id,
        ((md5('pavlodar:map-feature:' || ir.version_id::text || ':' || ir.row_index::text))::uuid)::text AS feature_id,
        ir.payload->>'source_record_id' AS source_record_id,
        ir.payload->'properties' AS properties,
        layer_scope.geometry_type,
        ST_Transform(ir.geometry,3857) AS geom
      FROM import_records ir CROSS JOIN bounds CROSS JOIN layer_scope
      WHERE ir.version_id=layer_scope.dataset_version_id
        AND (
          (layer_scope.geometry_type='point' AND GeometryType(ir.geometry) IN ('POINT','MULTIPOINT'))
          OR (layer_scope.geometry_type='line' AND GeometryType(ir.geometry) IN ('LINESTRING','MULTILINESTRING'))
          OR (layer_scope.geometry_type='polygon' AND GeometryType(ir.geometry) IN ('POLYGON','MULTIPOLYGON'))
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
    SELECT COALESCE(
      (SELECT ST_AsMVT(tile_rows,'features',4096,'geom','mvt_id')
       FROM tile_rows WHERE geom IS NOT NULL),
      ''::bytea
    ) AS tile
    """
)


@dataclass(frozen=True)
class ArchiveResult:
    path: Path
    sha256: str
    byte_size: int
    tile_count: int
    candidate_tile_count: int
    min_zoom: int
    max_zoom: int


def _artifact_path(root: Path, storage_key: str) -> Path:
    root = root.resolve()
    path = (root / storage_key).resolve()
    if root not in path.parents:
        raise ArchiveBuildError("pmtiles_storage_key_invalid", "Archive path leaves tile root")
    return path


def register_archive(
    db,
    layer_id: str,
    root: Path,
    *,
    min_zoom: int,
    max_zoom: int,
    max_candidate_tiles: int = DEFAULT_MAX_CANDIDATE_TILES,
) -> ArchiveResult:
    """Build one canonical archive and atomically add its immutable registry row."""
    existing = db.scalar(
        select(MapArchiveArtifact).where(MapArchiveArtifact.map_layer_id == layer_id)
    )
    if existing:
        if (existing.min_zoom, existing.max_zoom) != (min_zoom, max_zoom):
            raise ArchiveBuildError(
                "pmtiles_artifact_conflict",
                "This immutable layer already has an archive with a different zoom range",
            )
        path = _artifact_path(root, existing.storage_key)
        if not path.is_file() or path.stat().st_size != existing.byte_size:
            raise ArchiveBuildError(
                "pmtiles_artifact_missing", "Registered archive bytes are unavailable"
            )
        return ArchiveResult(
            path=path,
            sha256=existing.sha256,
            byte_size=existing.byte_size,
            tile_count=existing.tile_count,
            candidate_tile_count=existing.candidate_tile_count,
            min_zoom=existing.min_zoom,
            max_zoom=existing.max_zoom,
        )

    scope = _checked_scope(db, layer_id)
    artifact_id = str(
        uuid5(NAMESPACE_URL, f"pavlodar:pmtiles:{layer_id}:{min_zoom}:{max_zoom}")
    )
    storage_key = f"pmtiles/{artifact_id}.pmtiles"
    result = build_archive(
        db,
        layer_id,
        _artifact_path(root, storage_key),
        min_zoom=min_zoom,
        max_zoom=max_zoom,
        max_candidate_tiles=max_candidate_tiles,
    )
    db.add(
        MapArchiveArtifact(
            id=artifact_id,
            map_layer_id=layer_id,
            dataset_version_id=scope["dataset_version_id"],
            storage_key=storage_key,
            sha256=result.sha256,
            byte_size=result.byte_size,
            tile_count=result.tile_count,
            candidate_tile_count=result.candidate_tile_count,
            min_zoom=result.min_zoom,
            max_zoom=result.max_zoom,
            created_at=datetime.now(UTC),
        )
    )
    db.flush()
    return result


def _tile_coordinate(lon: float, lat: float, zoom: int) -> tuple[int, int]:
    lat = max(-WEB_MERCATOR_MAX_LAT, min(WEB_MERCATOR_MAX_LAT, lat))
    size = 1 << zoom
    x = math.floor((lon + 180.0) / 360.0 * size)
    y = math.floor(
        (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * size
    )
    return max(0, min(size - 1, x)), max(0, min(size - 1, y))


def _tile_ranges(bounds: tuple[float, float, float, float], min_zoom: int, max_zoom: int):
    min_lon, min_lat, max_lon, max_lat = bounds
    for zoom in range(min_zoom, max_zoom + 1):
        min_x, max_y = _tile_coordinate(min_lon, min_lat, zoom)
        max_x, min_y = _tile_coordinate(max_lon, max_lat, zoom)
        for x in range(min(min_x, max_x), max(min_x, max_x) + 1):
            for y in range(min(min_y, max_y), max(min_y, max_y) + 1):
                yield zoom, x, y


def _checked_scope(db, layer_id: str):
    row = db.execute(LAYER_SCOPE_QUERY, {"layer_id": layer_id}).mappings().one_or_none()
    if row is None:
        raise ArchiveBuildError("not_found", "Published vector layer has no geometry")
    if row["access_level"] != "public":
        raise ArchiveBuildError(
            "pmtiles_protected_layer",
            "Protected layers must remain behind per-request authorization",
        )
    if not row["is_current"] or row["status"] != "published":
        raise ArchiveBuildError(
            "pmtiles_layer_not_current", "Only the current publication can be archived"
        )
    return row


def build_archive(
    db,
    layer_id: str,
    destination: Path,
    *,
    min_zoom: int,
    max_zoom: int,
    max_candidate_tiles: int = DEFAULT_MAX_CANDIDATE_TILES,
) -> ArchiveResult:
    """Build and verify a deterministic PMTiles v3 archive, then atomically publish it."""
    if not 0 <= min_zoom <= max_zoom <= 22:
        raise ArchiveBuildError("invalid_parameter", "PMTiles zoom range is invalid")
    scope = _checked_scope(db, layer_id)
    bounds = tuple(
        float(scope[key]) for key in ("min_lon", "min_lat", "max_lon", "max_lat")
    )
    candidates = list(_tile_ranges(bounds, min_zoom, max_zoom))
    if not candidates or len(candidates) > max_candidate_tiles:
        raise ArchiveBuildError(
            "pmtiles_candidate_limit",
            f"Archive would inspect {len(candidates)} tiles; limit is {max_candidate_tiles}",
        )

    destination = destination.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.part")
    temporary.unlink(missing_ok=True)
    tile_count = 0
    try:
        with temporary.open("xb") as stream:
            writer = Writer(stream)
            for zoom, x, y in candidates:
                tile = bytes(
                    db.execute(
                        ARCHIVE_TILE_QUERY,
                            {
                                "layer_id": layer_id,
                                "z": zoom,
                                "x": x,
                                "y": y,
                                "tolerance": simplification_tolerance(zoom),
                            },
                    ).scalar_one()
                )
                if tile:
                    writer.write_tile(zxy_to_tileid(zoom, x, y), tile)
                    tile_count += 1
            if tile_count == 0:
                raise ArchiveBuildError("pmtiles_empty", "No non-empty tiles were produced")
            payload = scope["payload"]
            writer.finalize(
                {
                    "tile_compression": Compression.NONE,
                    "tile_type": TileType.MVT,
                    "min_lon_e7": round(bounds[0] * 10_000_000),
                    "min_lat_e7": round(bounds[1] * 10_000_000),
                    "max_lon_e7": round(bounds[2] * 10_000_000),
                    "max_lat_e7": round(bounds[3] * 10_000_000),
                    "center_zoom": min_zoom,
                },
                {
                    "name": payload["name"],
                    "attribution": payload["attribution"],
                    "vector_layers": [{"id": "features", "fields": {}}],
                },
            )
        os.chmod(temporary, 0o644)
        with temporary.open("rb") as stream:
            def read_range(offset, length):
                stream.seek(offset)
                return stream.read(length)

            reader = Reader(read_range)
            header = reader.header()
            metadata = reader.metadata()
            if header["version"] != 3 or header["tile_type"] != TileType.MVT:
                raise ArchiveBuildError("pmtiles_verification_failed", "Invalid PMTiles header")
            if metadata.get("vector_layers", [{}])[0].get("id") != "features":
                raise ArchiveBuildError("pmtiles_verification_failed", "Invalid PMTiles metadata")
        digest = hashlib.sha256(temporary.read_bytes()).hexdigest()
        byte_size = temporary.stat().st_size
        os.replace(temporary, destination)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise

    return ArchiveResult(
        path=destination,
        sha256=digest,
        byte_size=byte_size,
        tile_count=tile_count,
        candidate_tile_count=len(candidates),
        min_zoom=min_zoom,
        max_zoom=max_zoom,
    )
