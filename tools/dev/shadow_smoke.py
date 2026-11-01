"""Real OIDC/outbox/worker smoke for canonical shadow result and GeoJSON artifact."""

import argparse
import json
import time
from pathlib import Path
from uuid import uuid4

import httpx

from packages.domain.contracts import validate
from services.api.research import CITY_ID
from tools.dev.smoke_oidc import login

ROOT = Path(__file__).parents[2]
EVIDENCE = ROOT / "docs/evidence/wp08-shadow-live.json"


def mutation(client, method, path, body):
    return client.request(
        method,
        path,
        headers={"Idempotency-Key": str(uuid4())},
        json=body,
    )


def wait_for_job(client, job_id):
    deadline = time.monotonic() + 240
    while True:
        response = client.get(f"/v1/jobs/{job_id}")
        assert response.status_code == 200, response.text
        job = response.json()
        if job["state"] in {"succeeded", "failed", "cancelled"}:
            return job
        if time.monotonic() >= deadline:
            raise TimeoutError(f"Shadow job {job_id} did not finish")
        time.sleep(1)


def revision(zone, buildings_version_id):
    return {
        "zone_version_id": zone["version_id"],
        "parent_revision_id": None,
        "dataset_version_ids": [buildings_version_id],
        "catalog_version_id": None,
        "rate_version_id": None,
        "coefficient_version_id": None,
        "rule_version_id": None,
        "model_version_id": None,
        "placements": [],
        "area_patches": [],
        "capital_budget": None,
        "care_horizon_years": 3,
        "resource_limits": [],
        "excluded_plant_ids": [],
        "diversity_caps": [],
        "care_strategy": "standard",
        "custom_care_operations": [],
        "comment": "SYNTHETIC TEST zone geometry; real published building inputs",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://localhost:8001")
    args = parser.parse_args()
    imported = json.loads(
        (ROOT / "docs/evidence/pavlodar_open_import.json").read_text(encoding="utf-8")
    )
    buildings_version_id = next(
        item["dataset_version_id"] for item in imported["datasets"] if item["profile"] == "buildings"
    )

    with httpx.Client(base_url=args.base_url, timeout=60, follow_redirects=False) as specialist:
        me = login(specialist, "specialist")
        assert CITY_ID in me["city_ids"]
        zone_response = mutation(
            specialist,
            "POST",
            "/v1/zones",
            {
                "city_id": CITY_ID,
                "name": "SYNTHETIC TEST shadow live zone",
                "purpose": "other",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [76.9650, 52.2841],
                            [76.9662, 52.2841],
                            [76.9662, 52.2858],
                            [76.9650, 52.2858],
                            [76.9650, 52.2841],
                        ]
                    ],
                },
            },
        )
        assert zone_response.status_code == 201, zone_response.text
        zone = zone_response.json()
        scenario_response = mutation(
            specialist,
            "POST",
            "/v1/scenarios",
            {
                "city_id": CITY_ID,
                "zone_id": zone["id"],
                "name": "SYNTHETIC TEST live shadow pipeline",
                "base_revision_id": None,
                "initial_state": revision(zone, buildings_version_id),
            },
        )
        assert scenario_response.status_code == 201, scenario_response.text
        scenario = scenario_response.json()
        queued = mutation(
            specialist,
            "POST",
            "/v1/shadow-runs",
            {
                "scenario_revision_id": scenario["current_revision_id"],
                "datetime": "2026-06-21T11:52:00+05:00",
                "grid_resolution_m": 2.0,
                "geometry_mode": "estimated_preview",
                "include_neighbor_buffer": True,
            },
        )
        assert queued.status_code == 202, queued.text
        validate("Job", queued.json())
        job = wait_for_job(specialist, queued.json()["id"])
        assert job["state"] == "succeeded", job
        result_response = specialist.get(f"/v1/spatial-results/{job['result_ref_id']}")
        assert result_response.status_code == 200, result_response.text
        result = result_response.json()
        validate("SpatialResult", result)
        assert result["kind"] == "shadow" and result["artifact_url"]
        artifact_response = specialist.get(result["artifact_url"])
        assert artifact_response.status_code == 200, artifact_response.text
        assert artifact_response.headers["content-type"].startswith("application/geo+json")
        artifact = artifact_response.json()
        validate("SpatialResultArtifact", artifact)

    evidence = {
        "passed": True,
        "scope": "Real OIDC -> HTTP -> PostgreSQL outbox -> Redis/Celery worker -> immutable SpatialResult -> authorized GeoJSON artifact",
        "contract_version": "1.4.0",
        "migration": "0016_spatial_results",
        "city_id": CITY_ID,
        "dataset_version_id": buildings_version_id,
        "zone_id": zone["id"],
        "scenario_revision_id": scenario["current_revision_id"],
        "job_id": job["id"],
        "result_id": result["id"],
        "status": result["status"],
        "shade_area_m2": result["metrics"][0]["value"],
        "used_buildings": artifact["metadata"]["used_buildings"],
        "artifact_geometry_type": (
            artifact["features"][0]["geometry"]["type"]
            if artifact["features"][0]["geometry"]
            else None
        ),
        "synthetic_test_zone": True,
        "real_published_building_inputs": True,
    }
    EVIDENCE.write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(evidence, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
