from datetime import UTC, datetime
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from packages.domain.contracts import validate
from services.api.db import engine, session
from services.api.models import CalculationSnapshotRecord, Job, PriorityResultRecord
from services.worker.main import run_job
from tests.test_foundation import mutation
from tests.test_programs import program_body
from tools.dev.seed import CITY_ID

pytestmark = pytest.mark.integration
SPECIALIST_ID = "00000000-0000-4000-8000-000000000002"
NORMALIZATION_ID = "f5f9b550-42ab-5bfd-bf5e-2c442ad5e254"


def add_priority_and_calculations(body):
    priority_id = str(uuid4())
    created = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    from services.api.models import Scenario, ScenarioRevision

    with session() as db, db.begin():
        zones = []
        for index, revision_id in enumerate(body["candidate_revision_ids"]):
            revision = db.get(ScenarioRevision, revision_id)
            zone_id = db.get(Scenario, revision.scenario_id).zone_id
            zones.append(
                {
                    "zone_id": zone_id,
                    "score": 80.0 - index * 10,
                    "need_score": 80.0 - index * 10,
                    "readiness_score": None,
                    "data_coverage": 1.0,
                    "contributions": [
                        {
                            "factor": "green_deficit",
                            "score": 0.8 - index * 0.1,
                            "weight": 1.0,
                            "explanation": "SYNTHETIC TEST frozen normalized factor",
                            "source_refs": [],
                        }
                    ],
                }
            )
        priority = {
            "id": priority_id,
            "city_id": CITY_ID,
            "weights": [{"factor": "green_deficit", "weight": 1.0}],
            "normalization_version_id": NORMALIZATION_ID,
            "zones": zones,
            "created_at": created,
        }
        validate("PriorityResult", priority)
        db.add(
            PriorityResultRecord(
                id=priority_id,
                city_id=CITY_ID,
                actor_id=SPECIALIST_ID,
                normalization_version_id=NORMALIZATION_ID,
                payload=priority,
                created_at=datetime.fromisoformat(created),
            )
        )
        for index, revision_id in enumerate(body["candidate_revision_ids"]):
            snapshot_id, job_id = str(uuid4()), str(uuid4())
            total = f"{60 - index * 10}.00"
            snapshot = {
                "id": snapshot_id,
                "scenario_revision_id": revision_id,
                "input_hash": "a" * 64,
                "created_at": created,
                "status": "complete",
                "is_stale": False,
                "synthetic_inputs": True,
                "cost": {
                    "currency": "KZT",
                    "status": "complete",
                    "known_subtotal": total,
                    "total": total,
                    "lines": [],
                    "data_gaps": [],
                },
                "survival": [],
                "care": [],
                "ecosystem": [],
                "warnings": [],
                "manifest_url": f"/v1/calculations/{snapshot_id}/manifest",
            }
            validate("CalculationSnapshot", snapshot)
            db.add(
                CalculationSnapshotRecord(
                    id=snapshot_id,
                    scenario_revision_id=revision_id,
                    actor_id=SPECIALIST_ID,
                    input_hash="a" * 64,
                    created_at=datetime.fromisoformat(created),
                    payload=snapshot,
                    manifest={},
                )
            )
            db.add(
                Job(
                    id=job_id,
                    owner_id=SPECIALIST_ID,
                    city_id=CITY_ID,
                    input_revision_id=revision_id,
                    input_ref_id=revision_id,
                    input_kind="revision",
                    state="succeeded",
                    attempt=1,
                    lease_token=None,
                    lease_until=None,
                    request_payload={
                        "scenario_revision_id": revision_id,
                        "mode": "full",
                        "include_modules": ["cost", "care"],
                        "seed": 1,
                    },
                    payload={
                        "id": job_id,
                        "kind": "calculate",
                        "state": "succeeded",
                        "phase": None,
                        "progress": 1,
                        "input_ref_id": revision_id,
                        "result_ref_id": snapshot_id,
                        "attempt": 1,
                        "created_at": created,
                        "started_at": created,
                        "completed_at": created,
                        "error": None,
                    },
                )
            )
    return priority_id


def test_optimize_program_job_persists_revision_and_bounds(clients):
    body = program_body(clients)
    priority_id = add_priority_and_calculations(body)
    body["benefit_weights"] = [{"factor": "green_deficit", "weight": 1.0}]
    body["priority_result_id"] = priority_id
    body["capital_budget"] = "100.00"
    created = mutation(clients["specialist"], "POST", "/v1/programs", body)
    assert created.status_code == 201, created.text

    queued = mutation(
        clients["specialist"],
        "POST",
        f"/v1/programs/{created.json()['id']}/optimize",
        {"program_id": created.json()["id"], "time_limit_seconds": 5, "seed": 11},
        etag=created.headers["etag"],
    )
    assert queued.status_code == 202, queued.text
    run_job.run(queued.json()["id"])
    job = clients["specialist"].get(f"/v1/jobs/{queued.json()['id']}")
    assert job.status_code == 200, job.text
    assert job.json()["state"] == "succeeded"

    revision = clients["specialist"].get(
        f"/v1/program-revisions/{job.json()['result_ref_id']}"
    )
    assert revision.status_code == 200, revision.text
    validate("ProgramRevision", revision.json())
    assert revision.json()["solver_status"] == "optimal"
    assert revision.json()["selected_scenario_revision_ids"] == [
        body["candidate_revision_ids"][0]
    ]
    assert len(revision.json()["calculation_snapshot_ids"]) == 2
    assert revision.json()["objective"] == 80
    assert revision.json()["best_bound"] == 80
    assert revision.json()["gap"] == 0
    assert revision.json()["capital_total"] == "60.00"
    assert revision.json()["constraint_violations"] == []
    assert clients["viewer"].get(revision.request.url.path).status_code == 404
    assert clients["admin"].get(revision.request.url.path).status_code == 200
    listed = clients["specialist"].get(
        f"/v1/programs/{created.json()['id']}/revisions"
    )
    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()["items"]] == [revision.json()["id"]]
    diff_path = (
        f"/v1/programs/{created.json()['id']}/revisions/{revision.json()['id']}"
        f"/diff/{revision.json()['id']}"
    )
    difference = clients["specialist"].get(diff_path)
    assert difference.status_code == 200, difference.text
    validate("ProgramRevisionDiff", difference.json())
    assert difference.json()["base_revision"]["id"] == revision.json()["id"]
    assert difference.json()["target_revision"]["id"] == revision.json()["id"]
    assert difference.json()["added_scenario_revision_ids"] == []
    assert difference.json()["removed_scenario_revision_ids"] == []
    assert difference.json()["added_calculation_snapshot_ids"] == []
    assert difference.json()["removed_calculation_snapshot_ids"] == []
    assert difference.json()["changed_input_fields"] == []
    assert difference.json()["objective_delta"] == 0
    assert difference.json()["capital_delta"] == "0.00"
    assert clients["viewer"].get(diff_path).status_code == 404

    current = clients["specialist"].get(f"/v1/programs/{created.json()['id']}")
    review = mutation(
        clients["specialist"],
        "POST",
        f"/v1/programs/{created.json()['id']}/transitions",
        {
            "target_status": "in_review",
            "reason": "SYNTHETIC TEST manual solver review",
            "revision_id": revision.json()["id"],
        },
        etag=current.headers["etag"],
    )
    assert review.status_code == 200, review.text
    assert review.json()["status"] == "in_review"
    denied = mutation(
        clients["specialist"],
        "POST",
        f"/v1/programs/{created.json()['id']}/transitions",
        {
            "target_status": "approved",
            "reason": "SYNTHETIC TEST specialist cannot approve",
            "revision_id": revision.json()["id"],
        },
        etag=review.headers["etag"],
    )
    assert denied.status_code == 403, denied.text
    approval = mutation(
        clients["admin"],
        "POST",
        f"/v1/programs/{created.json()['id']}/transitions",
        {
            "target_status": "approved",
            "reason": "SYNTHETIC TEST approval must be blocked",
            "revision_id": revision.json()["id"],
        },
        etag=review.headers["etag"],
    )
    assert approval.status_code == 422, approval.text
    assert {item["code"] for item in approval.json()["blockers"]} == {
        "program_approval_synthetic",
        "program_scenario_not_approved",
    }
    with pytest.raises(DBAPIError), engine().begin() as connection:
        connection.execute(
            text("UPDATE program_revisions SET payload=payload WHERE id=:id"),
            {"id": revision.json()["id"]},
        )


def test_optimize_program_requires_frozen_priority_result(clients):
    body = program_body(clients)
    created = mutation(clients["specialist"], "POST", "/v1/programs", body)
    assert created.status_code == 201, created.text
    response = mutation(
        clients["specialist"],
        "POST",
        f"/v1/programs/{created.json()['id']}/optimize",
        {"program_id": created.json()["id"], "time_limit_seconds": 5, "seed": 0},
        etag=created.headers["etag"],
    )
    assert response.status_code == 422
    assert response.json()["code"] == "program_priority_invalid"
