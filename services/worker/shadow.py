"""Shadow runs: startShadowRun -> Job(kind=shadow) -> SpatialResult (ADR-030).

The computation runs outside database transactions so that a cancel request is seen while it
runs: inputs are read in one short transaction, the geometry work calls a checkpoint that renews
the lease (and observes cancel_requested) at most every HEARTBEAT_S seconds, and the result is
written in a final short transaction through jobs.complete(), which re-checks the lease.

A run that exceeds DEADLINE_S fails with shadow_timeout (no retry: the same input would time out
again). A worker crash leaves the lease to expire and jobs.recover() requeues it (bounded
attempts); the result id is derived from the job id, so a repeated attempt cannot store twice.
"""

import time
import uuid
from datetime import datetime

import numpy as np
import shapely
from pyproj import Transformer
from shapely import wkb
from shapely.geometry import mapping, shape
from sqlalchemy import text

from packages.domain.errors import DomainError
from packages.domain.heights import record_height
from packages.domain.shadow import (
    MAX_SHADOW_LENGTH_M,
    METHOD_VERSION,
    Building,
    ShadowInputs,
    ShadowOutcome,
    SunPosition,
    Tree,
    compute_shadows,
    solar_position,
)
from services.api.models import (
    Dataset,
    DatasetVersion,
    ScenarioRevision,
    SpatialResultRecord,
    ZoneVersion,
)

DEADLINE_S = 200.0  # below the Celery soft limit (240 s) so the job fails with a typed reason
HEARTBEAT_S = 20.0
MAX_BUILDINGS = 20_000
TO_METRIC = Transformer.from_crs("EPSG:4326", "EPSG:32643", always_xy=True)
TO_WGS84 = Transformer.from_crs("EPSG:32643", "EPSG:4326", always_xy=True)


def reproject(geometry, transformer):
    return shapely.transform(
        geometry, lambda xy: np.column_stack(transformer.transform(xy[:, 0], xy[:, 1]))
    )


RESULT_NAMESPACE = uuid.UUID("6b1f3f0e-5f0c-4c55-9a3e-6c2f6d1e9a01")

class Cancelled(Exception):
    """The owner asked to cancel; the job ends as cancelled, not failed."""


def parse_request(body: dict) -> datetime:
    """Request checks the JSON schema cannot express."""
    when = datetime.fromisoformat(body["datetime"])  # Python 3.12 accepts a trailing Z
    if when.tzinfo is None:
        raise DomainError(422, "shadow_datetime_naive", "Shadow datetime needs an explicit offset")
    if body["geometry_mode"] not in {"analytical_verified", "estimated_preview"}:
        raise DomainError(422, "shadow_mode_invalid", "Unknown geometry_mode")
    return when


def result_id(job_id: str) -> str:
    return str(uuid.uuid5(RESULT_NAMESPACE, job_id))


def load_inputs(db, revision_id: str, request: dict) -> dict:
    """Frozen revision inputs in metres: zone, buildings of frozen buildings datasets, trees."""
    revision = db.get(ScenarioRevision, revision_id)
    zone_version = db.get(ZoneVersion, revision.payload["zone_version_id"])
    zone_wgs = shape(zone_version.payload["geometry"])
    zone = reproject(zone_wgs, TO_METRIC)
    when = parse_request(request)
    centre = zone_wgs.representative_point()
    sun = solar_position(when, centre.y, centre.x)

    versions = []
    for version_id in revision.payload.get("dataset_version_ids", []):
        version = db.get(DatasetVersion, version_id)
        dataset = db.get(Dataset, version.dataset_id) if version else None
        if dataset is not None and dataset.payload.get("kind") == "buildings":
            versions.append((version, dataset))
    buildings, source_refs = [], []
    if versions and sun.elevation_deg > 0:
        rows = db.execute(
            text(
                """
                SELECT version_id::text AS version_id, row_index, payload,
                  ST_AsBinary(ST_Transform(geometry, 32643)) AS footprint
                FROM import_records
                WHERE version_id = ANY(CAST(:ids AS uuid[])) AND geometry IS NOT NULL
                  AND ST_DWithin(ST_Transform(geometry, 32643),
                                 ST_GeomFromWKB(:zone, 32643), :reach)
                ORDER BY version_id, row_index
                LIMIT :limit
                """
            ),
            {
                "ids": [v.id for v, _ in versions],
                "zone": zone.wkb,
                "reach": MAX_SHADOW_LENGTH_M,
                "limit": MAX_BUILDINGS + 1,
            },
        ).mappings()
        for row in rows:
            properties = row["payload"].get("properties", {})
            height, basis, _ = record_height(properties)
            buildings.append(
                Building(
                    source_record_id=row["payload"].get("source_record_id")
                    or f"{row['version_id']}:{row['row_index']}",
                    footprint=wkb.loads(bytes(row["footprint"])),
                    height_m=height,
                    height_basis=basis,
                )
            )
        if len(buildings) > MAX_BUILDINGS:
            raise DomainError(
                422, "shadow_inputs_too_large", f"More than {MAX_BUILDINGS} buildings in reach"
            )
        source_refs = [
            {
                "dataset_version_id": str(v.id),
                "source_record_id": None,
                "label": d.payload["name"],
                "uri": d.payload.get("source_uri"),
            }
            for v, d in versions
        ]
    trees = []
    for p in revision.payload.get("placements", []):
        x, y = TO_METRIC.transform(*p["position"]["coordinates"][:2])
        trees.append(
            Tree(
                placement_id=p["id"],
                x=x,
                y=y,
                height_m=p.get("initial_height_m"),
                crown_radius_m=p.get("initial_crown_radius_m"),
                dimension_basis=p.get("dimension_basis", "unknown"),
                quantity=p.get("quantity", 1),
            )
        )
    return {
        "revision_id": revision.id,
        "zone": zone,
        "sun": sun,
        "buildings": buildings,
        "trees": trees,
        "has_buildings_dataset": bool(versions),
        "source_refs": source_refs,
        "synthetic": bool(revision.payload.get("synthetic_inputs") or zone_version.synthetic),
    }


def _gap(code, message, inputs=(), blocking=True):
    return {"code": code, "message": message, "required_inputs": list(inputs), "blocking": blocking}


EXCLUSION_MESSAGES = {
    "height_unknown": "Здания без известной высоты не отбрасывают тень в расчёте",
    "height_basis_not_allowed": "Высота здания не подходит для выбранного режима геометрии",
    "height_out_of_range": "Высота здания вне допустимого диапазона",
    "footprint_not_polygon": "Контур здания не является полигоном",
    "footprint_invalid": "Контур здания топологически некорректен",
    "footprint_area_out_of_range": "Площадь контура здания вне допустимого диапазона",
    "dimensions_unknown": "У посадки не указаны высота и радиус кроны",
    "dimension_basis_not_allowed": "Размеры посадки не подходят для выбранного режима геометрии",
    "dimensions_out_of_range": "Размеры посадки вне допустимого диапазона",
    "position_invalid": "Координаты посадки некорректны",
}


def build_result(
    rid: str, revision_id: str, inputs: dict, outcome: ShadowOutcome | None, request, created_at
):
    """SpatialResult payload and artifact. Unknown is never reported as zero shade."""
    gaps, sun = [], inputs["sun"]
    status = "complete"
    if outcome is None:
        status = "unavailable"
        gaps.append(_gap("sun_below_horizon", "Солнце ниже горизонта в выбранный момент"))
    else:
        if not inputs["has_buildings_dataset"]:
            status = "partial"
            gaps.append(
                _gap(
                    "buildings_dataset_missing",
                    "В ревизии нет набора зданий: тени зданий не учтены",
                    ["dataset_version_ids"],
                )
            )
        elif inputs["buildings"] and not outcome.used_buildings:
            status = "partial"
            gaps.append(
                _gap(
                    "building_heights_missing",
                    "Ни у одного здания рядом с участком нет пригодной высоты",
                    ["height_m", "height_basis"],
                )
            )
        for reason, ids in sorted(outcome.excluded.items()):
            gaps.append(
                _gap(
                    "shadow_input_excluded:" + reason,
                    f"{EXCLUSION_MESSAGES[reason]}: {len(ids)}",
                    ids[:20],
                    blocking=False,
                )
            )
        if outcome.capped:
            gaps.append(
                _gap(
                    "shadow_length_capped",
                    f"Низкое солнце: тени ограничены {int(MAX_SHADOW_LENGTH_M)} м",
                    blocking=False,
                )
            )
    mode = request["geometry_mode"]
    # Without the buildings the shaded area is unknown (trees alone would understate it).
    if outcome is None or (status == "partial" and not outcome.used_buildings):
        metric = {
            "key": "shade_area",
            "value": None,
            "unit": "m2",
            "horizon_year": 0,
            "status": "unavailable",
            "lower": None,
            "upper": None,
            "qualitative_confidence": "unknown",
            "method_version": METHOD_VERSION,
            "source_refs": inputs["source_refs"],
            "missing_reason": gaps[0],
        }
    else:
        metric = {
            "key": "shade_area",
            "value": round(outcome.shaded_open_ground_m2, 2),
            "unit": "m2",
            "horizon_year": 0,
            "status": "synthetic" if inputs["synthetic"] else "estimated",
            "lower": None,
            "upper": None,
            "qualitative_confidence": "medium" if mode == "analytical_verified" else "low",
            "method_version": METHOD_VERSION,
            "source_refs": inputs["source_refs"],
            "missing_reason": None,
        }
    payload = {
        "id": rid,
        "scenario_revision_id": revision_id,
        "kind": "shadow",
        "status": status,
        "artifact_url": None if outcome is None else f"/v1/spatial-results/{rid}/artifact",
        "metrics": [metric],
        "data_gaps": gaps,
        "created_at": created_at,
    }
    artifact = None
    if outcome is not None:
        artifact = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "id": "shadow",
                    "geometry": mapping(reproject(outcome.shadow, TO_WGS84))
                    if not outcome.shadow.is_empty
                    else None,
                    "properties": {"role": "shadow"},
                }
            ],
            "metadata": {
                "method_version": METHOD_VERSION,
                "datetime": request["datetime"],
                "geometry_mode": mode,
                "sun": {"elevation_deg": sun.elevation_deg, "azimuth_deg": sun.azimuth_deg},
                "crs_of_grid": "EPSG:32643",
                "grid": {k: v for k, v in outcome.grid.items() if k != "values"},
                "grid_values": outcome.grid["values"],
                "zone_area_m2": outcome.zone_area_m2,
                "open_ground_m2": outcome.open_ground_m2,
                "used_buildings": len(outcome.used_buildings),
                "used_trees": len(outcome.used_trees),
            },
        }
    return payload, artifact


class Checkpoint:
    """Deadline + lease renewal with cancel detection, at most every HEARTBEAT_S seconds."""

    def __init__(self, renew, clock=time.monotonic, deadline_s=DEADLINE_S):
        self.renew, self.clock = renew, clock
        self.started = self.last = clock()
        self.deadline_s = deadline_s

    def __call__(self, progress: float):
        now = self.clock()
        if now - self.started > self.deadline_s:
            raise DomainError(503, "shadow_timeout", "Shadow run exceeded its time limit")
        if now - self.last >= HEARTBEAT_S:
            self.last = now
            if not self.renew(progress):
                raise Cancelled


def run_shadow(job_id: str, token: str, session, jobs, now, clock=time.monotonic):
    """Orchestrates one claimed shadow job. `jobs` is services.worker.jobs (injectable for tests)."""
    with session() as db, db.begin():
        job = jobs.leased(db, job_id, token)
        request, revision_id = job.request_payload, job.input_revision_id
        inputs = load_inputs(db, revision_id, request)
        jobs.state(db, job, job.state, phase="computing", progress=0.1)

    def renew(progress):
        with session() as db, db.begin():
            alive = jobs.heartbeat(db, job_id, token)
            if alive:
                job = jobs.leased(db, job_id, token)
                jobs.state(db, job, job.state, phase="computing", progress=round(progress, 2))
            return alive

    sun: SunPosition = inputs["sun"]
    outcome = None
    try:
        if sun.elevation_deg > 0:
            outcome = compute_shadows(
                ShadowInputs(
                    inputs["zone"],
                    inputs["buildings"],
                    inputs["trees"],
                    request["geometry_mode"],
                    request["grid_resolution_m"],
                ),
                sun,
                Checkpoint(renew, clock),
            )
    except Cancelled:
        with session() as db, db.begin():
            jobs.complete(db, job_id, token, lambda db, job: None)  # ends as cancelled
        return
    rid = result_id(job_id)
    payload, artifact = build_result(rid, revision_id, inputs, outcome, request, now())

    def persist(db, job):
        db.add(
            SpatialResultRecord(
                id=rid,
                scenario_revision_id=revision_id,
                city_id=job.city_id,
                job_id=job.id,
                kind="shadow",
                payload=payload,
                artifact=artifact,
                created_at=datetime.fromisoformat(payload["created_at"]),
            )
        )
        return rid

    with session() as db, db.begin():
        jobs.complete(db, job_id, token, persist)


def get_spatial_result(db, access, result_id_value: str) -> dict:
    """getSpatialResult: the stored payload after re-authorizing the revision's inputs."""
    from services.api.use_cases import authorized_revision, found

    row = found(db.get(SpatialResultRecord, result_id_value))
    authorized_revision(db, access, row.scenario_revision_id)
    return row.payload


def get_spatial_artifact(db, access, result_id_value: str) -> dict:
    """Return the immutable display artifact after the same revision authorization."""
    from services.api.use_cases import authorized_revision, found

    row = found(db.get(SpatialResultRecord, result_id_value))
    authorized_revision(db, access, row.scenario_revision_id)
    return found(row.artifact)
