import copy

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError

from packages.domain.contracts import validate
from services.api.db import session
from services.api.models import (
    ProgramInputCandidate,
    ProgramInputVersion,
    Scenario,
    ScenarioRevision,
)
from services.api.priorities import NORMALIZATION_VERSION_ID
from tests.test_foundation import create_scenario, mutation
from tools.dev.seed import CITY_ID

pytestmark = pytest.mark.integration


def program_body(clients):
    first_zone, _, first = create_scenario(clients["specialist"])
    second_zone, _, second = create_scenario(clients["specialist"])
    return {
        "city_id": CITY_ID,
        "name": "SYNTHETIC TEST city program",
        "capital_budget": "100000.00",
        "resource_limits": [
            {
                "period": "year:1",
                "water_m3": 100.0,
                "crew_minutes": 1000,
                "max_visits": 10,
                "care_budget": "20000.00",
            }
        ],
        "candidate_revision_ids": [
            first.json()["current_revision_id"],
            second.json()["current_revision_id"],
        ],
        "required_zone_ids": [first_zone["id"]],
        "excluded_zone_ids": [],
        "benefit_weights": [
            {"factor": "green_deficit", "weight": 0.7},
            {"factor": "readiness", "weight": 0.3},
        ],
        "diversity_caps": [],
        "coverage_requirements": [
            {
                "group_id": "pilot",
                "zone_ids": [first_zone["id"], second_zone["id"]],
                "minimum_selected_zones": 1,
            }
        ],
    }


def test_program_draft_versions_conflicts_and_access(clients):
    body = program_body(clients)
    created = mutation(clients["specialist"], "POST", "/v1/programs", body)
    assert created.status_code == 201, created.text
    program = created.json()
    validate("Program", program)
    assert program["status"] == "draft" and program["current_revision_id"] is None
    assert clients["viewer"].get(f"/v1/programs/{program['id']}").status_code == 404
    assert clients["admin"].get(f"/v1/programs/{program['id']}").status_code == 200
    assert (
        clients["specialist"]
        .get("/v1/programs", params={"city_id": CITY_ID})
        .json()["items"][0]["id"]
        == program["id"]
    )

    changed = {**body, "capital_budget": "90000.00"}
    updated = mutation(
        clients["specialist"],
        "PUT",
        f"/v1/programs/{program['id']}",
        changed,
        etag=created.headers["etag"],
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["capital_budget"] == "90000.00"
    stale = mutation(
        clients["specialist"],
        "PUT",
        f"/v1/programs/{program['id']}",
        body,
        etag=created.headers["etag"],
    )
    assert stale.status_code == 412

    with session() as db:
        versions = list(
            db.scalars(
                select(ProgramInputVersion)
                .where(ProgramInputVersion.program_id == program["id"])
                .order_by(ProgramInputVersion.created_at)
            )
        )
        assert len(versions) == 2
        assert versions[0].payload == body
        assert versions[1].payload == changed
        assert db.scalar(
            select(func.count())
            .select_from(ProgramInputCandidate)
            .where(ProgramInputCandidate.input_version_id == versions[1].id)
        ) == len(body["candidate_revision_ids"])
    with pytest.raises(DBAPIError), session() as db, db.begin():
        db.execute(
            text("UPDATE program_input_versions SET payload=payload WHERE id=:id"),
            {"id": versions[0].id},
        )


def test_program_input_validation_and_idempotent_replay(clients):
    body = program_body(clients)
    key = "program-replay-key"
    first = mutation(clients["specialist"], "POST", "/v1/programs", body, key=key)
    replay = mutation(clients["specialist"], "POST", "/v1/programs", body, key=key)
    assert first.status_code == replay.status_code == 201
    assert first.json() == replay.json()

    invalid = copy.deepcopy(body)
    invalid["benefit_weights"] = [{"factor": "green_deficit", "weight": 0}]
    assert mutation(clients["specialist"], "POST", "/v1/programs", invalid).status_code == 422

    invalid = copy.deepcopy(body)
    invalid["excluded_zone_ids"] = invalid["required_zone_ids"]
    assert mutation(clients["specialist"], "POST", "/v1/programs", invalid).status_code == 422

    invalid = copy.deepcopy(body)
    invalid["candidate_revision_ids"].append(invalid["candidate_revision_ids"][0])
    assert mutation(clients["specialist"], "POST", "/v1/programs", invalid).status_code == 422


def test_program_input_can_freeze_an_authorized_priority_result(clients):
    body = program_body(clients)
    with session() as db:
        zone_ids = [
            db.get(Scenario, db.get(ScenarioRevision, revision_id).scenario_id).zone_id
            for revision_id in body["candidate_revision_ids"]
        ]
    weights = [{"factor": "green_deficit", "weight": 1.0}]
    priority = mutation(
        clients["specialist"],
        "POST",
        "/v1/priorities",
        {
            "city_id": CITY_ID,
            "zone_ids": zone_ids,
            "weights": weights,
            "normalization_version_id": NORMALIZATION_VERSION_ID,
        },
    )
    assert priority.status_code == 200, priority.text
    body["benefit_weights"] = weights
    body["priority_result_id"] = priority.json()["id"]
    created = mutation(clients["specialist"], "POST", "/v1/programs", body)
    assert created.status_code == 201, created.text
    validate("Program", created.json())
    with session() as db:
        version = db.scalar(
            select(ProgramInputVersion).where(ProgramInputVersion.program_id == created.json()["id"])
        )
        assert version.priority_result_id == priority.json()["id"]

    invalid = copy.deepcopy(body)
    invalid["benefit_weights"] = [{"factor": "green_deficit", "weight": 0.5}]
    response = mutation(clients["specialist"], "POST", "/v1/programs", invalid)
    assert response.status_code == 422
    assert response.json()["code"] == "program_priority_invalid"
