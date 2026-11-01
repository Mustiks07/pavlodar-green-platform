import pytest

from packages.domain.contracts import validate
from tests.test_catalog import publish_rule
from tests.test_foundation import create_zone, mutation
from tests.test_zone_context import polygon_feature, publish_features

pytestmark = pytest.mark.integration

RULE_ID = "72000000-0000-4000-8000-000000000001"


def test_detected_problem_is_derived_and_dismissed_durably(clients):
    publish_rule(clients, rule_id=RULE_ID)
    zone = create_zone(clients["specialist"]).json()
    publish_features(
        clients,
        "restrictions",
        [
            {
                "type": "Feature",
                "id": "heat-restriction",
                "properties": {
                    "restriction_kind": "heat_risk",
                    "rule_version_id": RULE_ID,
                    "status": "confirmed",
                },
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [76.9801, 52.2801],
                            [76.9809, 52.2801],
                            [76.9809, 52.2809],
                            [76.9801, 52.2809],
                            [76.9801, 52.2801],
                        ]
                    ],
                },
            }
        ],
    )

    page = clients["viewer"].get("/v1/problems", params={"city_id": zone["city_id"]})
    assert page.status_code == 200, page.text
    assert len(page.json()["items"]) == 1
    problem = page.json()["items"][0]
    validate("DetectedProblem", problem)
    assert problem["zone_id"] == zone["id"]
    assert problem["kind"] == "heat"
    assert problem["severity"] == "high"
    assert problem["status"] == "open"

    denied = mutation(
        clients["viewer"],
        "POST",
        f"/v1/problems/{problem['id']}/dismiss",
        {"reason": "viewer cannot decide"},
    )
    assert denied.status_code == 403

    dismissed = mutation(
        clients["specialist"],
        "POST",
        f"/v1/problems/{problem['id']}/dismiss",
        {"reason": "Учтено в проектном обследовании"},
    )
    assert dismissed.status_code == 200, dismissed.text
    assert dismissed.json()["status"] == "dismissed"

    restored = clients["viewer"].get("/v1/problems", params={"city_id": zone["city_id"]})
    assert restored.json()["items"][0]["status"] == "dismissed"
    assert restored.json()["items"][0]["dismissal_reason"] == "Учтено в проектном обследовании"


def test_green_deficit_uses_versioned_target_and_measured_coverage(clients):
    rule_id = "72000000-0000-4000-8000-000000000002"
    publish_rule(
        clients,
        rule_id=rule_id,
        parameter="green_coverage_target",
        value=0.3,
        unit="1",
    )
    zone = create_zone(clients["specialist"]).json()
    publish_features(
        clients,
        "green_inventory",
        [polygon_feature("small-green", 76.98, 52.28, 76.9802, 52.2802)],
    )

    page = clients["viewer"].get("/v1/problems", params={"city_id": zone["city_id"]})
    assert page.status_code == 200, page.text
    problems = [item for item in page.json()["items"] if item["kind"] == "green_deficit"]
    assert len(problems) == 1
    problem = problems[0]
    validate("DetectedProblem", problem)
    assert problem["zone_id"] == zone["id"]
    assert problem["rule_version_id"] == rule_id
    assert problem["severity"] == "high"
    assert "30%" in problem["description"]
    assert problem["source_refs"]
