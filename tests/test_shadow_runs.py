"""startShadowRun -> outbox job -> worker -> SpatialResult on PostGIS (ADR-030).

Skipped with an explicit reason until migration 0016_spatial_results exists and both operations
are listed in IMPLEMENTED (GPT owns migrations and the implemented subset).
"""

from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from packages.domain.contracts import validate
from services.api.db import engine
from services.api.main import IMPLEMENTED
from services.worker.main import run_job
from tests.test_foundation import create_zone, mutation, revision_body
from tests.test_zone_context import polygon_feature, publish_features
from tools.dev.seed import CITY_ID

pytestmark = pytest.mark.skipif(
    not {"startShadowRun", "getSpatialResult", "getSpatialResultArtifact"} <= IMPLEMENTED,
    reason="ADR-030 shadow operations require migration 0016_spatial_results",
)

# Zone of tests.test_foundation: lon 76.980..76.981, lat 52.280..52.281.
NOON = "2026-06-21T11:52:00+05:00"  # close to solar noon in Pavlodar (UTC+5)


@pytest.fixture
def shadow_revision(clients, database):
    with engine().connect() as conn:
        if not conn.scalar(text("SELECT to_regclass('public.spatial_results') IS NOT NULL")):
            pytest.skip("ADR-030: table spatial_results is not migrated")
    buildings = publish_features(
        clients,
        "buildings",
        [
            # 20 m (OSM height) just south of the zone: its noon shadow reaches into the zone.
            polygon_feature("tall", 76.9802, 52.27985, 76.9808, 52.27995, {"height": "20"}),
            polygon_feature("no-height", 76.9790, 52.2790, 76.9792, 52.2792, {}),
        ],
    )
    specialist = clients["specialist"]
    zone = create_zone(specialist).json()
    initial = {**revision_body(zone), "dataset_version_ids": [buildings]}
    created = mutation(
        specialist,
        "POST",
        "/v1/scenarios",
        {
            "city_id": CITY_ID,
            "zone_id": zone["id"],
            "name": "SYNTHETIC TEST shadow",
            "base_revision_id": None,
            "initial_state": initial,
        },
    )
    assert created.status_code == 201, created.text
    return created.json()["current_revision_id"], buildings


def start(client, revision_id, *, when=NOON, mode="estimated_preview", key=None):
    body = {
        "scenario_revision_id": revision_id,
        "datetime": when,
        "grid_resolution_m": 1.0,
        "geometry_mode": mode,
        "include_neighbor_buffer": True,
    }
    return mutation(client, "POST", "/v1/shadow-runs", body, key=key)


def finished(client, job_id):
    run_job.run(job_id)
    job = client.get(f"/v1/jobs/{job_id}")
    assert job.status_code == 200, job.text
    return job.json()


def test_shadow_run_end_to_end_with_exact_inputs_and_replay(clients, shadow_revision):
    revision_id, buildings = shadow_revision
    specialist = clients["specialist"]
    key = str(uuid4())
    queued = start(specialist, revision_id, key=key)
    assert queued.status_code == 202, queued.text
    assert queued.json()["kind"] == "shadow" and queued.json()["state"] == "queued"
    assert start(specialist, revision_id, key=key).json() == queued.json()  # idempotent replay

    job = finished(specialist, queued.json()["id"])
    assert job["state"] == "succeeded", job
    result = specialist.get(f"/v1/spatial-results/{job['result_ref_id']}")
    assert result.status_code == 200, result.text
    body = result.json()
    validate("SpatialResult", body)
    assert body["kind"] == "shadow" and body["status"] == "complete"
    metric = body["metrics"][0]
    assert metric["key"] == "shade_area" and metric["unit"] == "m2"
    assert metric["value"] > 0 and metric["status"] in {"estimated", "synthetic"}
    assert metric["source_refs"][0]["dataset_version_id"] == buildings
    codes = {gap["code"] for gap in body["data_gaps"]}
    assert "shadow_input_excluded:height_unknown" in codes
    artifact = specialist.get(body["artifact_url"])
    assert artifact.status_code == 200, artifact.text
    assert artifact.headers["content-type"].startswith("application/geo+json")
    validate("SpatialResultArtifact", artifact.json())
    assert artifact.json()["features"][0]["geometry"]["type"] in {"Polygon", "MultiPolygon"}
    with pytest.raises(DBAPIError), engine().begin() as conn:
        conn.execute(
            text("UPDATE spatial_results SET payload = payload WHERE id = :id"),
            {"id": body["id"]},
        )

    # A run is reproducible: the same request gives the same area.
    again = finished(specialist, start(specialist, revision_id).json()["id"])
    second = specialist.get(f"/v1/spatial-results/{again['result_ref_id']}").json()
    assert second["metrics"][0]["value"] == metric["value"]
    assert second["id"] != body["id"]


def test_recorded_heights_are_not_accepted_as_verified(clients, shadow_revision):
    revision_id, _ = shadow_revision
    specialist = clients["specialist"]
    job = finished(
        specialist, start(specialist, revision_id, mode="analytical_verified").json()["id"]
    )
    body = specialist.get(f"/v1/spatial-results/{job['result_ref_id']}").json()
    assert body["status"] == "partial"
    assert body["metrics"][0]["value"] is None
    assert body["metrics"][0]["missing_reason"]["code"] == "building_heights_missing"


def test_night_run_is_unavailable_not_zero(clients, shadow_revision):
    revision_id, _ = shadow_revision
    specialist = clients["specialist"]
    job = finished(
        specialist, start(specialist, revision_id, when="2026-06-21T23:30:00+05:00").json()["id"]
    )
    body = specialist.get(f"/v1/spatial-results/{job['result_ref_id']}").json()
    assert body["status"] == "unavailable" and body["artifact_url"] is None
    assert body["metrics"][0]["missing_reason"]["code"] == "sun_below_horizon"
    assert specialist.get(f"/v1/spatial-results/{job['result_ref_id']}/artifact").status_code == 404


def test_request_validation_cancel_and_access(clients, shadow_revision):
    revision_id, _ = shadow_revision
    specialist = clients["specialist"]
    naive = start(specialist, revision_id, when="2026-06-21T12:00:00")
    # The contract's date-time format already requires an offset; the worker re-checks it.
    assert naive.status_code == 422
    assert start(clients["viewer"], revision_id).status_code == 403

    queued = start(specialist, revision_id).json()
    cancelled = mutation(
        specialist, "POST", f"/v1/jobs/{queued['id']}/cancel", {"reason": "SYNTHETIC TEST cancel"}
    )
    assert cancelled.status_code == 200, cancelled.text
    job = finished(specialist, queued["id"])
    assert job["state"] == "cancelled" and job["result_ref_id"] is None

    done = finished(specialist, start(specialist, revision_id).json()["id"])
    result_url = f"/v1/spatial-results/{done['result_ref_id']}"
    assert clients["outsider"].get(result_url).status_code == 404
    assert clients["outsider"].get(result_url + "/artifact").status_code == 404
