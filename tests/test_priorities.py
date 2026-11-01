import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from packages.domain.contracts import validate
from services.api.db import session
from services.api.models import DatasetVersion
from services.api.priorities import NORMALIZATION_VERSION_ID
from tests.test_foundation import create_zone, mutation
from tests.test_zone_context import polygon_feature, publish_features
from tools.dev.seed import CITY_ID

pytestmark = pytest.mark.integration


def request(zone_id, *, normalization_id=NORMALIZATION_VERSION_ID):
    return {
        "city_id": CITY_ID,
        "zone_ids": [zone_id],
        "weights": [
            {"factor": "green_deficit", "weight": 1.0},
            {"factor": "soil_coverage", "weight": 1.0},
        ],
        "normalization_version_id": normalization_id,
    }


def test_priority_discovery_and_unknown_values_stay_null(clients):
    listed = clients["viewer"].get("/v1/priority-normalizations")
    assert listed.status_code == 200, listed.text
    assert listed.json()["items"][0]["id"] == NORMALIZATION_VERSION_ID
    validate("PriorityNormalizationPage", listed.json())

    zone = create_zone(clients["specialist"]).json()
    response = mutation(clients["specialist"], "POST", "/v1/priorities", request(zone["id"]))
    assert response.status_code == 200, response.text
    result = response.json()
    validate("PriorityResult", result)
    priority = result["zones"][0]
    assert priority["score"] is None
    assert priority["need_score"] is None
    assert priority["readiness_score"] is None
    assert priority["data_coverage"] == 0
    assert [item["score"] for item in priority["contributions"]] == [None, None]
    assert clients["viewer"].get(f"/v1/priorities/{result['id']}").status_code == 404
    assert clients["admin"].get(f"/v1/priorities/{result['id']}").status_code == 200

    with pytest.raises(DBAPIError), session() as db, db.begin():
        db.execute(
            text("UPDATE priority_results SET payload=payload WHERE id=:id"),
            {"id": result["id"]},
        )


def test_priority_uses_only_registered_ratio_formulas(clients):
    zone = create_zone(clients["specialist"]).json()
    west, south, east, north = 76.98, 52.28, 76.981, 52.281
    middle_x = (west + east) / 2
    middle_y = (south + north) / 2
    soil_version_id = publish_features(
        clients,
        "soil",
        [polygon_feature("soil-half", west, south, middle_x, north)],
        access_level="restricted",
    )
    publish_features(
        clients,
        "green_inventory",
        [polygon_feature("green-quarter", west, south, middle_x, middle_y)],
    )

    response = mutation(clients["specialist"], "POST", "/v1/priorities", request(zone["id"]))
    assert response.status_code == 200, response.text
    priority = response.json()["zones"][0]
    assert priority["score"] == pytest.approx(62.5, abs=0.2)
    assert priority["need_score"] == pytest.approx(75, abs=0.3)
    assert priority["readiness_score"] == pytest.approx(50, abs=0.2)
    assert priority["data_coverage"] == 1
    assert all(item["source_refs"] for item in priority["contributions"])

    invalid = request(zone["id"], normalization_id="11111111-1111-4111-8111-111111111111")
    assert mutation(clients["specialist"], "POST", "/v1/priorities", invalid).status_code == 422
    invalid = request(zone["id"])
    invalid["weights"][0]["factor"] = "invented_factor"
    assert mutation(clients["specialist"], "POST", "/v1/priorities", invalid).status_code == 422

    with session() as db:
        soil_dataset_id = db.get(DatasetVersion, soil_version_id).dataset_id
    revoked = mutation(
        clients["admin"],
        "DELETE",
        f"/v1/datasets/{soil_dataset_id}/grants/00000000-0000-4000-8000-000000000002",
        {"reason": "SYNTHETIC TEST priority access revoked"},
    )
    assert revoked.status_code == 200, revoked.text
    result_id = response.json()["id"]
    assert clients["specialist"].get(f"/v1/priorities/{result_id}").status_code == 404
