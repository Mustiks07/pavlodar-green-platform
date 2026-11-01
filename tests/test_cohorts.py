import copy
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from packages.domain.contracts import validate
from services.api.db import session
from services.api.models import (
    CalculationSnapshotRecord,
    CohortRecord,
    InspectionRecord,
    PlantIdentity,
    Scenario,
    ScenarioRevision,
)
from tests.test_foundation import create_scenario, mutation
from tools.dev.seed import CITY_ID

pytestmark = pytest.mark.integration


def execution_scenario(clients):
    zone, _, created = create_scenario(clients["specialist"])
    scenario = created.json()
    first_plant, second_plant, third_plant = (str(uuid4()) for _ in range(3))
    placements = [
        {
            "id": str(uuid4()),
            "plant_id": first_plant,
            "stock_item_id": None,
            "position": {"type": "Point", "coordinates": [76.9803, 52.2803]},
            "quantity": 5,
            "planting_date": "2026-11-01",
            "locked": False,
            "initial_height_m": None,
            "initial_crown_radius_m": None,
            "dimension_basis": "unknown",
        },
        {
            "id": str(uuid4()),
            "plant_id": second_plant,
            "stock_item_id": None,
            "position": {"type": "Point", "coordinates": [76.9804, 52.2804]},
            "quantity": 2,
            "planting_date": "2027-05-01",
            "locked": False,
            "initial_height_m": None,
            "initial_crown_radius_m": None,
            "dimension_basis": "unknown",
        },
        {
            "id": str(uuid4()),
            "plant_id": third_plant,
            "stock_item_id": None,
            "position": {"type": "Point", "coordinates": [76.9805, 52.2805]},
            "quantity": 1,
            "planting_date": "2027-05-02",
            "locked": False,
            "initial_height_m": None,
            "initial_crown_radius_m": None,
            "dimension_basis": "unknown",
        },
    ]
    with session() as db, db.begin():
        stored = db.get(Scenario, scenario["id"])
        previous = db.get(ScenarioRevision, stored.current_revision_id)
        revision_id = str(uuid4())
        payload = copy.deepcopy(previous.payload)
        payload.update(
            {
                "id": revision_id,
                "parent_revision_id": previous.id,
                "placements": placements,
                "created_at": "2026-10-30T12:00:00Z",
                "input_hash": "0" * 64,
                "synthetic_inputs": False,
            }
        )
        for plant_id in (first_plant, second_plant, third_plant):
            db.add(PlantIdentity(id=plant_id))
        db.add(
            ScenarioRevision(
                id=revision_id,
                scenario_id=stored.id,
                zone_version_id=previous.zone_version_id,
                parent_revision_id=previous.id,
                payload=payload,
            )
        )
        stored.current_revision_id = revision_id
        stored.status = "approved"
        stored.payload = {
            **stored.payload,
            "current_revision_id": revision_id,
            "status": "approved",
        }
    return zone, scenario["id"], revision_id, placements


def completed_order(clients, zone, revision_id, quantity, performed_at):
    specialist = clients["specialist"]
    created = mutation(
        specialist,
        "POST",
        "/v1/work-orders",
        {
            "city_id": CITY_ID,
            "scenario_revision_id": revision_id,
            "zone_id": zone["id"],
            "operation": "SYNTHETIC TEST посадка",
            "planned_start": performed_at[:10],
            "planned_end": performed_at[:10],
            "quantity": quantity,
            "unit": "piece",
            "assignee_group": "SYNTHETIC TEST crew",
        },
    )
    assert created.status_code == 201, created.text
    assigned = mutation(
        specialist,
        "POST",
        f"/v1/work-orders/{created.json()['id']}/transitions",
        {"target_status": "assigned", "reason": "SYNTHETIC TEST assigned"},
        etag=created.headers["etag"],
    )
    progress = mutation(
        specialist,
        "POST",
        f"/v1/work-orders/{created.json()['id']}/transitions",
        {"target_status": "in_progress", "reason": "SYNTHETIC TEST started"},
        etag=assigned.headers["etag"],
    )
    completion = mutation(
        specialist,
        "POST",
        f"/v1/work-orders/{created.json()['id']}/completions",
        {
            "performed_at": performed_at,
            "quantity": quantity,
            "water_m3": None,
            "crew_minutes": 60,
            "note": "SYNTHETIC TEST planting evidence",
            "correction_of_id": None,
        },
        etag=progress.headers["etag"],
    )
    current = specialist.get(f"/v1/work-orders/{created.json()['id']}")
    completed = mutation(
        specialist,
        "POST",
        f"/v1/work-orders/{created.json()['id']}/transitions",
        {"target_status": "completed", "reason": "SYNTHETIC TEST recorded"},
        etag=current.headers["etag"],
    )
    assert completion.status_code == 201 and completed.status_code == 200
    return completed.json()


def test_cohort_inspection_and_replacement_preserve_lineage(clients):
    zone, _, revision_id, placements = execution_scenario(clients)
    first_order = completed_order(
        clients, zone, revision_id, 5, "2026-11-01T10:00:00Z"
    )
    created = mutation(
        clients["specialist"],
        "POST",
        "/v1/cohorts",
        {
            "work_order_id": first_order["id"],
            "placement_id": placements[0]["id"],
            "planting_date": "2026-11-01",
        },
    )
    assert created.status_code == 201, created.text
    validate("Cohort", created.json())
    assert created.json()["initial_quantity"] == 5
    assert created.json()["plant_id"] == placements[0]["plant_id"]
    assert created.json()["placement_id"] == placements[0]["id"]
    assert created.json()["source_work_order_id"] == first_order["id"]
    replayed_order = mutation(
        clients["specialist"],
        "POST",
        "/v1/cohorts",
        {
            "work_order_id": first_order["id"],
            "placement_id": placements[0]["id"],
            "planting_date": "2026-11-01",
        },
    )
    assert replayed_order.status_code == 409
    assert replayed_order.json()["code"] == "cohort_work_order_used"

    partial = mutation(
        clients["specialist"],
        "POST",
        "/v1/inspections",
        {
            "city_id": CITY_ID,
            "zone_id": zone["id"],
            "cohort_id": created.json()["id"],
            "observed_at": "2027-10-30T09:00:00Z",
            "alive_count": 3,
            "dead_count": 1,
            "unknown_count": 0,
            "method": "SYNTHETIC TEST count",
            "note": "SYNTHETIC TEST partial coverage",
            "source_refs": [],
        },
    )
    assert partial.status_code == 201, partial.text
    later = mutation(
        clients["specialist"],
        "POST",
        "/v1/inspections",
        {
            "city_id": CITY_ID,
            "zone_id": zone["id"],
            "cohort_id": created.json()["id"],
            "observed_at": "2027-11-01T09:00:00Z",
            "alive_count": 3,
            "dead_count": 2,
            "unknown_count": 0,
            "method": "SYNTHETIC TEST count",
            "note": "SYNTHETIC TEST full coverage",
            "source_refs": [],
        },
    )
    assert later.status_code == 201, later.text
    validate("Inspection", later.json())
    cohorts = clients["viewer"].get(
        "/v1/cohorts", params={"city_id": CITY_ID, "zone_id": zone["id"]}
    )
    assert cohorts.status_code == 200
    assert cohorts.json()["items"][0]["latest_inspection_id"] == later.json()["id"]
    inspections = clients["viewer"].get(
        "/v1/inspections",
        params={"city_id": CITY_ID, "cohort_id": created.json()["id"]},
    )
    assert inspections.status_code == 200
    assert len(inspections.json()["items"]) == 2

    calculation_id = str(uuid4())
    with session() as db, db.begin():
        db.add(
            CalculationSnapshotRecord(
                id=calculation_id,
                scenario_revision_id=revision_id,
                actor_id="00000000-0000-4000-8000-000000000002",
                input_hash="1" * 64,
                created_at=datetime.now(UTC),
                payload={
                    "id": calculation_id,
                    "scenario_revision_id": revision_id,
                    "status": "complete",
                    "survival": [
                        {
                            "placement_id": placements[0]["id"],
                            "points": [
                                {"year": 1, "probability": 0.8},
                                {"year": 2, "probability": 0.7},
                                {"year": 3, "probability": 0.6},
                            ],
                        }
                    ],
                },
                manifest={},
            )
        )
    comparison = mutation(
        clients["specialist"],
        "POST",
        "/v1/forecast-observed",
        {
            "cohort_id": created.json()["id"],
            "calculation_id": calculation_id,
            "inspection_id": later.json()["id"],
            "horizon_year": 1,
        },
    )
    assert comparison.status_code == 200, comparison.text
    validate("ForecastObservedResult", comparison.json())
    assert comparison.json()["comparable"] is True
    assert comparison.json()["date_offset_days"] == 0
    assert comparison.json()["forecast_probability"] == 0.8
    assert comparison.json()["forecast_expected_alive"] == 4
    assert comparison.json()["observed_survival_probability"] == 0.6
    assert comparison.json()["initial_quantity"] == 5
    assert comparison.json()["observed_alive_initial"] == 3
    assert comparison.json()["replacement_cohort_count"] == 0
    assert comparison.json()["replacements_planted"] == 0
    assert comparison.json()["replacements_alive"] == 0
    assert comparison.json()["total_alive"] == 3
    assert comparison.json()["observation_coverage"] == 1
    assert comparison.json()["probability_delta"] == -0.2
    incomplete = mutation(
        clients["specialist"],
        "POST",
        "/v1/forecast-observed",
        {
            "cohort_id": created.json()["id"],
            "calculation_id": calculation_id,
            "inspection_id": partial.json()["id"],
            "horizon_year": 1,
        },
    )
    assert incomplete.status_code == 200
    assert incomplete.json()["comparable"] is False
    assert incomplete.json()["probability_delta"] is None
    assert {item["code"] for item in incomplete.json()["data_gaps"]} == {
        "comparison_observation_coverage"
    }

    replacement_order = completed_order(
        clients, zone, revision_id, 2, "2027-11-02T11:00:00Z"
    )
    replacement = mutation(
        clients["specialist"],
        "POST",
        "/v1/replacements",
        {
            "original_cohort_id": created.json()["id"],
            "plant_id": placements[1]["plant_id"],
            "quantity": 2,
            "planting_date": "2027-11-02",
            "reason": "SYNTHETIC TEST confirmed deaths",
            "work_order_id": replacement_order["id"],
        },
    )
    assert replacement.status_code == 201, replacement.text
    assert replacement.json()["replaces_cohort_id"] == created.json()["id"]
    assert replacement.json()["initial_quantity"] == 2

    replacement_unobserved = mutation(
        clients["specialist"],
        "POST",
        "/v1/forecast-observed",
        {
            "cohort_id": created.json()["id"],
            "calculation_id": calculation_id,
            "inspection_id": later.json()["id"],
            "horizon_year": 1,
        },
    )
    assert replacement_unobserved.status_code == 200, replacement_unobserved.text
    validate("ForecastObservedResult", replacement_unobserved.json())
    assert replacement_unobserved.json()["comparable"] is True
    assert replacement_unobserved.json()["replacement_cohort_count"] == 1
    assert replacement_unobserved.json()["replacements_planted"] == 2
    assert replacement_unobserved.json()["replacements_alive"] is None
    assert replacement_unobserved.json()["total_alive"] is None
    assert {
        item["code"]: item["blocking"]
        for item in replacement_unobserved.json()["data_gaps"]
    } == {"comparison_replacement_observation_incomplete": False}

    replacement_inspection = mutation(
        clients["specialist"],
        "POST",
        "/v1/inspections",
        {
            "city_id": CITY_ID,
            "zone_id": zone["id"],
            "cohort_id": replacement.json()["id"],
            "observed_at": "2028-11-02T09:00:00Z",
            "alive_count": 2,
            "dead_count": 0,
            "unknown_count": 0,
            "method": "SYNTHETIC TEST count",
            "note": "SYNTHETIC TEST full replacement coverage",
            "source_refs": [],
        },
    )
    assert replacement_inspection.status_code == 201, replacement_inspection.text
    replacement_observed = mutation(
        clients["specialist"],
        "POST",
        "/v1/forecast-observed",
        {
            "cohort_id": created.json()["id"],
            "calculation_id": calculation_id,
            "inspection_id": later.json()["id"],
            "horizon_year": 1,
        },
    )
    assert replacement_observed.status_code == 200, replacement_observed.text
    validate("ForecastObservedResult", replacement_observed.json())
    assert replacement_observed.json()["initial_quantity"] == 5
    assert replacement_observed.json()["observed_alive_initial"] == 3
    assert replacement_observed.json()["replacements_alive"] == 2
    assert replacement_observed.json()["total_alive"] == 5
    assert replacement_observed.json()["observed_survival_probability"] == 0.6

    excessive_order = completed_order(
        clients, zone, revision_id, 1, "2027-11-03T11:00:00Z"
    )
    excessive = mutation(
        clients["specialist"],
        "POST",
        "/v1/replacements",
        {
            "original_cohort_id": created.json()["id"],
            "plant_id": placements[2]["plant_id"],
            "quantity": 1,
            "planting_date": "2027-11-03",
            "reason": "SYNTHETIC TEST exceeds observed deaths",
            "work_order_id": excessive_order["id"],
        },
    )
    assert excessive.status_code == 422
    assert excessive.json()["code"] == "replacement_quantity_exceeded"

    with pytest.raises(DBAPIError), session() as db, db.begin():
        db.execute(
            text("UPDATE inspections SET payload=payload WHERE id=:id"),
            {"id": later.json()["id"]},
        )
    with pytest.raises(DBAPIError), session() as db, db.begin():
        db.execute(
            text("UPDATE cohorts SET initial_quantity=initial_quantity+1 WHERE id=:id"),
            {"id": created.json()["id"]},
        )
    with session() as db:
        assert db.get(CohortRecord, created.json()["id"]).initial_quantity == 5
        assert db.get(InspectionRecord, later.json()["id"]).payload["dead_count"] == 2
