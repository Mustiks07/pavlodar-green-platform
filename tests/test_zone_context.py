import json

import pytest

from packages.domain.contracts import validate
from services.worker.main import run_job
from tests.test_foundation import create_zone, mutation
from tests.test_imports import create_dataset, start_import, upload

pytestmark = pytest.mark.integration

RULE_VERSION_ID = "70000000-0000-4000-8000-000000000001"


def publish_features(clients, kind, features, *, access_level="public"):
    specialist = clients["specialist"]
    dataset = create_dataset(specialist, access_level=access_level, kind=kind)
    if access_level == "restricted":
        granted = mutation(
            clients["admin"],
            "POST",
            f"/v1/datasets/{dataset['id']}/grants",
            {
                "user_id": "00000000-0000-4000-8000-000000000001",
                "reason": "SYNTHETIC TEST context publication review",
            },
        )
        assert granted.status_code == 201, granted.text
    content = json.dumps(
        {"type": "FeatureCollection", "features": features},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode()
    ticket = upload(
        specialist,
        dataset["id"],
        content,
        "application/geo+json",
        f"synthetic-{kind}.geojson",
    )
    job = start_import(specialist, dataset["id"], ticket, "geojson")
    run_job.run(job["id"])
    version_id = specialist.get(f"/v1/jobs/{job['id']}").json()["result_ref_id"]
    published = mutation(
        clients["admin"],
        "POST",
        f"/v1/dataset-versions/{version_id}/publish",
        {"reason": f"SYNTHETIC TEST {kind} context"},
    )
    assert published.status_code == 200, published.text
    return version_id


def polygon_feature(identity, west, south, east, north, properties=None):
    return {
        "type": "Feature",
        "id": identity,
        "properties": properties or {},
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                [[west, south], [east, south], [east, north], [west, north], [west, south]]
            ],
        },
    }


def test_zone_context_has_real_area_and_explicit_missing_inputs(clients):
    zone = create_zone(clients["specialist"]).json()
    response = clients["viewer"].get(f"/v1/zones/{zone['id']}/context")
    assert response.status_code == 200, response.text
    validate("ZoneContext", response.json())
    metrics = {item["key"]: item for item in response.json()["metrics"]}
    assert metrics["zone_area"]["value"] == zone["area_m2"]
    assert metrics["zone_area"]["status"] == "synthetic"
    assert metrics["soil_coverage_fraction"]["status"] == "unavailable"
    assert metrics["soil_coverage_fraction"]["value"] is None
    assert metrics["existing_green_area"]["status"] == "unavailable"
    assert {item["code"] for item in response.json()["data_gaps"]} == {
        "soil_data_missing",
        "green_inventory_missing",
        "restriction_data_missing",
        "utility_network_data_missing",
    }
    assert response.json()["source_refs"] == []
    assert response.json()["restrictions"] == []
    assert clients["outsider"].get(f"/v1/zones/{zone['id']}/context").status_code == 404


def test_zone_context_computes_partial_coverage_green_and_restrictions(clients):
    zone = create_zone(clients["specialist"]).json()
    west, south = 76.98, 52.28
    east, north = 76.981, 52.281
    middle_x = (west + east) / 2
    middle_y = (south + north) / 2

    soil_version = publish_features(
        clients,
        "soil",
        [polygon_feature("soil-half", west, south, middle_x, north, {"soil": "SYNTHETIC"})],
    )
    green_version = publish_features(
        clients,
        "green_inventory",
        [
            polygon_feature("green-quarter", west, south, middle_x, middle_y),
            {
                "type": "Feature",
                "id": "tree-point",
                "properties": {"kind": "SYNTHETIC tree"},
                "geometry": {
                    "type": "Point",
                    "coordinates": [middle_x + 0.0001, middle_y + 0.0001],
                },
            },
        ],
    )
    restriction_version = publish_features(
        clients,
        "restrictions",
        [
            {
                "type": "Feature",
                "id": "utility-line",
                "properties": {
                    "restriction_kind": "utility_buffer",
                    "network_kind": "water",
                    "rule_version_id": RULE_VERSION_ID,
                    "status": "confirmed",
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[west, middle_y], [east, middle_y]],
                },
            }
        ],
    )

    response = clients["viewer"].get(f"/v1/zones/{zone['id']}/context")
    assert response.status_code == 200, response.text
    context = response.json()
    validate("ZoneContext", context)
    metrics = {item["key"]: item for item in context["metrics"]}
    assert metrics["soil_coverage_fraction"]["value"] == pytest.approx(0.5, abs=0.002)
    assert metrics["soil_coverage_fraction"]["status"] == "synthetic"
    assert metrics["existing_green_area"]["value"] == pytest.approx(
        zone["area_m2"] * 0.25, rel=0.01
    )
    assert metrics["existing_green_feature_count"]["value"] == 2
    assert {ref["dataset_version_id"] for ref in context["source_refs"]} == {
        soil_version,
        green_version,
        restriction_version,
    }
    assert context["restrictions"] == [
        {
            "id": context["restrictions"][0]["id"],
            "kind": "utility_buffer",
            "rule_version_id": RULE_VERSION_ID,
            "geometry": {
                "type": "LineString",
                "coordinates": [[west, middle_y], [east, middle_y]],
            },
            "status": "confirmed",
        }
    ]
    assert {item["code"] for item in context["data_gaps"]} == {"soil_partial_coverage"}


def test_zone_context_excludes_restricted_sources_without_grant(clients):
    zone = create_zone(clients["specialist"]).json()
    publish_features(
        clients,
        "soil",
        [polygon_feature("restricted-soil", 76.98, 52.28, 76.981, 52.281)],
        access_level="restricted",
    )
    specialist = clients["specialist"].get(f"/v1/zones/{zone['id']}/context")
    viewer = clients["viewer"].get(f"/v1/zones/{zone['id']}/context")
    assert specialist.status_code == 200
    assert next(
        item for item in specialist.json()["metrics"] if item["key"] == "soil_coverage_fraction"
    )["status"] == "synthetic"
    viewer_soil = next(
        item for item in viewer.json()["metrics"] if item["key"] == "soil_coverage_fraction"
    )
    assert viewer_soil["status"] == "unavailable"
    assert viewer.json()["source_refs"] == []
