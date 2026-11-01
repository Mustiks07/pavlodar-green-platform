from uuid import uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from packages.domain.contracts import validate
from services.api.db import session
from services.api.models import Scenario, ScenarioRevision, WorkCompletionRecord, WorkOrderRecord
from tests.test_foundation import create_scenario, mutation
from tools.dev.seed import CITY_ID

pytestmark = pytest.mark.integration


def test_work_order_calendar_server_filters_and_cursor_binding(clients):
    first_zone, _, first_scenario_response = create_scenario(clients["specialist"])
    second_zone, _, second_scenario_response = create_scenario(clients["specialist"])

    def create(zone, scenario, operation, start, end, crew):
        response = mutation(
            clients["specialist"],
            "POST",
            "/v1/work-orders",
            {
                "city_id": CITY_ID,
                "scenario_revision_id": scenario["current_revision_id"],
                "zone_id": zone["id"],
                "operation": operation,
                "planned_start": start,
                "planned_end": end,
                "quantity": 1,
                "unit": "piece",
                "assignee_group": crew,
            },
        )
        assert response.status_code == 201, response.text
        return response.json()["id"]

    first = create(first_zone, first_scenario_response.json(), "SYNTHETIC TEST Полив деревьев", "2027-05-01", "2027-05-05", "SYNTHETIC Север")
    second = create(first_zone, first_scenario_response.json(), "SYNTHETIC TEST Обрезка", "2027-05-05", "2027-05-08", "SYNTHETIC Юг")
    third = create(second_zone, second_scenario_response.json(), "SYNTHETIC TEST Полив газона", "2027-06-01", "2027-06-03", "SYNTHETIC Север")
    fourth = create(second_zone, second_scenario_response.json(), "SYNTHETIC TEST Осмотр", "2027-07-01", "2027-07-02", "SYNTHETIC Запад")
    with session() as db, db.begin():
        completed = db.get(WorkOrderRecord, fourth)
        completed.status = "completed"
        completed.payload = {**completed.payload, "status": "completed"}

    def ids(**params):
        response = clients["specialist"].get(
            "/v1/work-orders", params={"city_id": CITY_ID, "limit": 100, **params}
        )
        assert response.status_code == 200, response.text
        return {item["id"] for item in response.json()["items"]}

    assert ids(zone_id=first_zone["id"]) == {first, second}
    assert ids(operation="полив") == {first, third}
    assert ids(assignee_group="север") == {first, third}
    assert ids(planned_from="2027-05-05", planned_to="2027-05-05") == {first, second}
    assert ids(
        zone_id=first_zone["id"],
        operation="полив",
        assignee_group="север",
        planned_from="2027-05-05",
        planned_to="2027-05-05",
        status="planned",
    ) == {first}
    invalid = clients["specialist"].get(
        "/v1/work-orders",
        params={"city_id": CITY_ID, "planned_from": "2027-07-01", "planned_to": "2027-06-01"},
    )
    assert invalid.status_code == 422
    assert invalid.json()["code"] == "invalid_parameter"

    page = clients["specialist"].get(
        "/v1/work-orders", params={"city_id": CITY_ID, "operation": "полив", "limit": 1}
    ).json()
    assert page["next_cursor"]
    mismatched = clients["specialist"].get(
        "/v1/work-orders",
        params={"city_id": CITY_ID, "operation": "полив", "assignee_group": "север", "limit": 1, "cursor": page["next_cursor"]},
    )
    assert mismatched.status_code == 422
    assert clients["viewer"].get(
        "/v1/work-orders", params={"city_id": CITY_ID, "limit": 100}
    ).json()["items"] == [clients["viewer"].get(f"/v1/work-orders/{fourth}").json()]


def test_work_order_partial_completion_correction_and_workflow(clients):
    zone, _, scenario_response = create_scenario(clients["specialist"])
    scenario = scenario_response.json()
    created = mutation(
        clients["specialist"],
        "POST",
        "/v1/work-orders",
        {
            "city_id": CITY_ID,
            "scenario_revision_id": scenario["current_revision_id"],
            "zone_id": zone["id"],
            "operation": "SYNTHETIC TEST посадка",
            "planned_start": "2026-11-01",
            "planned_end": "2026-11-02",
            "quantity": 10,
            "unit": "piece",
            "assignee_group": "SYNTHETIC TEST crew",
        },
    )
    assert created.status_code == 201, created.text
    validate("WorkOrder", created.json())
    order_id = created.json()["id"]
    assert created.json()["status"] == "planned"
    assert created.json()["completed_quantity"] == 0
    assert clients["viewer"].get(f"/v1/work-orders/{order_id}").status_code == 404

    blocked = mutation(
        clients["specialist"],
        "POST",
        f"/v1/work-orders/{order_id}/transitions",
        {"target_status": "assigned", "reason": "SYNTHETIC TEST not approved yet"},
        etag=created.headers["etag"],
    )
    assert blocked.status_code == 422
    assert blocked.json()["code"] == "work_order_execution_blocked"

    # Approval gates are tested elsewhere. This database fixture isolates the execution workflow.
    with session() as db, db.begin():
        stored = db.get(Scenario, scenario["id"])
        stored.status = "approved"
        stored.payload = {**stored.payload, "status": "approved"}

    assigned = mutation(
        clients["specialist"],
        "POST",
        f"/v1/work-orders/{order_id}/transitions",
        {"target_status": "assigned", "reason": "SYNTHETIC TEST assigned"},
        etag=created.headers["etag"],
    )
    assert assigned.status_code == 200, assigned.text
    progress = mutation(
        clients["specialist"],
        "POST",
        f"/v1/work-orders/{order_id}/transitions",
        {"target_status": "in_progress", "reason": "SYNTHETIC TEST started"},
        etag=assigned.headers["etag"],
    )
    assert progress.status_code == 200, progress.text

    first = mutation(
        clients["specialist"],
        "POST",
        f"/v1/work-orders/{order_id}/completions",
        {
            "performed_at": "2026-11-01T10:00:00Z",
            "quantity": 4,
            "water_m3": 1.5,
            "crew_minutes": 120,
            "note": "SYNTHETIC TEST first shift",
            "correction_of_id": None,
        },
        etag=progress.headers["etag"],
    )
    assert first.status_code == 201, first.text
    validate("WorkCompletion", first.json())
    current = clients["specialist"].get(f"/v1/work-orders/{order_id}")
    assert current.json()["completed_quantity"] == 4
    second = mutation(
        clients["specialist"],
        "POST",
        f"/v1/work-orders/{order_id}/completions",
        {
            "performed_at": "2026-11-02T10:00:00Z",
            "quantity": 6,
            "water_m3": 2,
            "crew_minutes": 180,
            "note": "SYNTHETIC TEST second shift",
            "correction_of_id": None,
        },
        etag=current.headers["etag"],
    )
    assert second.status_code == 201, second.text
    current = clients["specialist"].get(f"/v1/work-orders/{order_id}")
    assert current.json()["completed_quantity"] == 10
    completed = mutation(
        clients["specialist"],
        "POST",
        f"/v1/work-orders/{order_id}/transitions",
        {"target_status": "completed", "reason": "SYNTHETIC TEST all work recorded"},
        etag=current.headers["etag"],
    )
    assert completed.status_code == 200, completed.text
    assert clients["viewer"].get(f"/v1/work-orders/{order_id}").status_code == 200

    reopened = mutation(
        clients["specialist"],
        "POST",
        f"/v1/work-orders/{order_id}/transitions",
        {"target_status": "in_progress", "reason": "SYNTHETIC TEST correct evidence"},
        etag=completed.headers["etag"],
    )
    correction = mutation(
        clients["specialist"],
        "POST",
        f"/v1/work-orders/{order_id}/completions",
        {
            "performed_at": "2026-11-03T10:00:00Z",
            "quantity": 3,
            "water_m3": 1.25,
            "crew_minutes": 110,
            "note": "SYNTHETIC TEST corrected first shift",
            "correction_of_id": first.json()["id"],
        },
        etag=reopened.headers["etag"],
    )
    assert correction.status_code == 201, correction.text
    current = clients["specialist"].get(f"/v1/work-orders/{order_id}")
    assert current.json()["completed_quantity"] == 9
    duplicate = mutation(
        clients["specialist"],
        "POST",
        f"/v1/work-orders/{order_id}/completions",
        {
            "performed_at": "2026-11-03T11:00:00Z",
            "quantity": 3,
            "water_m3": None,
            "crew_minutes": None,
            "note": "SYNTHETIC TEST duplicate correction",
            "correction_of_id": first.json()["id"],
        },
        etag=current.headers["etag"],
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["code"] == "work_completion_already_corrected"

    listed = clients["specialist"].get(f"/v1/work-orders/{order_id}/completions")
    assert listed.status_code == 200
    assert len(listed.json()["items"]) == 3
    with session() as db:
        completion_id = db.scalar(select(WorkCompletionRecord.id).limit(1))
    with pytest.raises(DBAPIError), session() as db, db.begin():
        db.execute(
            text("UPDATE work_completions SET payload=payload WHERE id=:id"),
            {"id": completion_id},
        )


def test_care_work_order_enforces_frozen_calendar_and_actual_resources(clients):
    zone, _, scenario_response = create_scenario(clients["specialist"])
    scenario = scenario_response.json()
    placement_id = str(uuid4())
    operation_id = str(uuid4())
    revision_id = str(uuid4())
    with session() as db, db.begin():
        stored = db.get(Scenario, scenario["id"])
        previous = db.get(ScenarioRevision, stored.current_revision_id)
        payload = {
            **previous.payload,
            "id": revision_id,
            "parent_revision_id": previous.id,
            "placements": [
                {
                    "id": placement_id,
                    "plant_id": str(uuid4()),
                    "stock_item_id": None,
                    "position": {"type": "Point", "coordinates": [76.9805, 52.2805]},
                    "quantity": 2,
                    "planting_date": "2027-05-01",
                    "locked": False,
                    "initial_height_m": None,
                    "initial_crown_radius_m": None,
                    "dimension_basis": "unknown",
                }
            ],
            "custom_care_operations": [
                {
                    "id": operation_id,
                    "placement_ids": [placement_id],
                    "month": 5,
                    "year_offset": 0,
                    "operation": "SYNTHETIC TEST watering visit",
                    "quantity": 2,
                    "unit": "piece",
                    "water_m3": 1,
                    "crew_minutes": 100,
                    "visits": 1,
                    "rate_version_id": None,
                    "rule_version_id": str(uuid4()),
                }
            ],
            "resource_limits": [
                {
                    "period": "year:0",
                    "water_m3": 1,
                    "crew_minutes": 120,
                    "max_visits": 1,
                    "care_budget": "50.00",
                }
            ],
        }
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

    body = {
        "city_id": CITY_ID,
        "scenario_revision_id": revision_id,
        "zone_id": zone["id"],
        "operation": "SYNTHETIC TEST watering visit",
        "planned_start": "2027-05-10",
        "planned_end": "2027-05-20",
        "quantity": 2,
        "unit": "piece",
        "assignee_group": "SYNTHETIC TEST care crew",
        "care_operation_id": operation_id,
    }
    wrong_month = mutation(
        clients["specialist"],
        "POST",
        "/v1/work-orders",
        {**body, "planned_start": "2027-06-10", "planned_end": "2027-06-20"},
    )
    assert wrong_month.status_code == 422
    assert wrong_month.json()["code"] == "work_calendar_mismatch"
    created = mutation(clients["specialist"], "POST", "/v1/work-orders", body)
    assert created.status_code == 201, created.text
    assert created.json()["care_operation_id"] == operation_id
    assert created.json()["resource_period"] == "year:0"
    duplicate = mutation(clients["specialist"], "POST", "/v1/work-orders", body)
    assert duplicate.status_code == 409
    assert duplicate.json()["code"] == "work_care_operation_used"

    order_id = created.json()["id"]
    assigned = mutation(
        clients["specialist"],
        "POST",
        f"/v1/work-orders/{order_id}/transitions",
        {"target_status": "assigned", "reason": "SYNTHETIC TEST care assigned"},
        etag=created.headers["etag"],
    )
    progress = mutation(
        clients["specialist"],
        "POST",
        f"/v1/work-orders/{order_id}/transitions",
        {"target_status": "in_progress", "reason": "SYNTHETIC TEST care started"},
        etag=assigned.headers["etag"],
    )
    first = mutation(
        clients["specialist"],
        "POST",
        f"/v1/work-orders/{order_id}/completions",
        {
            "performed_at": "2027-05-12T10:00:00Z",
            "quantity": 1,
            "water_m3": 0.5,
            "crew_minutes": 50,
            "actual_care_cost": "20.00",
            "note": "SYNTHETIC TEST first care visit",
            "correction_of_id": None,
        },
        etag=progress.headers["etag"],
    )
    assert first.status_code == 201, first.text
    current = clients["specialist"].get(f"/v1/work-orders/{order_id}")
    missing_cost = mutation(
        clients["specialist"],
        "POST",
        f"/v1/work-orders/{order_id}/completions",
        {
            "performed_at": "2027-05-13T10:00:00Z",
            "quantity": 1,
            "water_m3": 0.5,
            "crew_minutes": 50,
            "note": "SYNTHETIC TEST missing actual cost",
            "correction_of_id": None,
        },
        etag=current.headers["etag"],
    )
    assert missing_cost.status_code == 422
    assert missing_cost.json()["code"] == "work_resource_evidence_missing"
    excessive = mutation(
        clients["specialist"],
        "POST",
        f"/v1/work-orders/{order_id}/completions",
        {
            "performed_at": "2027-05-12T10:00:00Z",
            "quantity": 2,
            "water_m3": 1.1,
            "crew_minutes": 100,
            "actual_care_cost": "50.00",
            "note": "SYNTHETIC TEST excessive corrected visit",
            "correction_of_id": first.json()["id"],
        },
        etag=current.headers["etag"],
    )
    assert excessive.status_code == 422
    assert excessive.json()["code"] == "work_resource_exceeded"
    corrected = mutation(
        clients["specialist"],
        "POST",
        f"/v1/work-orders/{order_id}/completions",
        {
            "performed_at": "2027-05-12T10:00:00Z",
            "quantity": 2,
            "water_m3": 1,
            "crew_minutes": 100,
            "actual_care_cost": "50.00",
            "note": "SYNTHETIC TEST corrected single care visit",
            "correction_of_id": first.json()["id"],
        },
        etag=current.headers["etag"],
    )
    assert corrected.status_code == 201, corrected.text
    current = clients["specialist"].get(f"/v1/work-orders/{order_id}")
    assert current.json()["completed_quantity"] == 2
    completed = mutation(
        clients["specialist"],
        "POST",
        f"/v1/work-orders/{order_id}/transitions",
        {"target_status": "completed", "reason": "SYNTHETIC TEST care complete"},
        etag=current.headers["etag"],
    )
    assert completed.status_code == 200, completed.text
