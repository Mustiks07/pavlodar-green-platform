from sqlalchemy import text

from services.api.db import session
from services.api.models import Principal, ScenarioRevision
from services.api.priorities import NORMALIZATION_VERSION_ID
from services.api.security import Access
from services.worker.jobs import claim, complete, enqueue
from services.worker.main import run_job
from tests.test_foundation import create_scenario, create_zone, mutation, revision_body
from tests.test_imports import geojson_bytes, start_import, upload
from tools.dev.cleanup_synthetic import build_scope, delete_scope, make_plan, scope_hash
from tools.dev.seed import CITY_ID


def create(clients, name, owner):
    response = mutation(
        clients["specialist"],
        "POST",
        "/v1/datasets",
        {
            "city_id": CITY_ID,
            "name": name,
            "kind": "green_inventory",
            "owner": owner,
            "license": "CC0-1.0",
            "access_level": "public",
            "source_uri": None,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def test_cleanup_plan_is_narrow_rechecked_and_deletes_only_allowlisted_tree(clients):
    target = create(
        clients, "SYNTHETIC TEST cleanup exact", "SYNTHETIC integration test"
    )
    retained = create(clients, "SYNTHETIC TEST user-authored", "Municipal specialist")
    ticket = upload(
        clients["specialist"],
        target,
        geojson_bytes(),
        "application/geo+json",
        "synthetic-cleanup.geojson",
    )
    job = start_import(clients["specialist"], target, ticket, "geojson")
    run_job.run(job["id"])

    with session() as db:
        plan = make_plan(db)
    assert plan["executable"] is True
    assert [item["id"] for item in plan["scope"]["datasets"]] == [target]
    assert plan["scope"]["counts"] == {
        "datasets": 1,
        "versions": 1,
        "uploads": 1,
        "map_layers": 0,
        "import_records": 1,
    }
    assert plan["scope_sha256"] == scope_hash(plan["scope"])

    with session() as db, db.begin():
        assert build_scope(db) == plan["scope"]
        assert delete_scope(db, plan["scope"]) == {"datasets": 1, "zones": 0}
    with session() as db:
        assert db.scalar(text("SELECT count(*) FROM datasets WHERE id=:id"), {"id": target}) == 0
        assert db.scalar(text("SELECT count(*) FROM datasets WHERE id=:id"), {"id": retained}) == 1
        triggers = db.scalar(
            text(
                "SELECT count(*) FROM pg_trigger "
                "WHERE tgname IN ('dataset_version_immutable','import_record_immutable') "
                "AND tgenabled <> 'O'"
            )
        )
        assert triggers == 0


def test_cleanup_deletes_only_fully_synthetic_scenario_tree(clients):
    target_zone, _, target_response = create_scenario(clients["specialist"])
    target_scenario = target_response.json()
    priority = mutation(
        clients["specialist"],
        "POST",
        "/v1/priorities",
        {
            "city_id": CITY_ID,
            "zone_ids": [target_zone["id"]],
            "weights": [{"factor": "green_deficit", "weight": 1}],
            "normalization_version_id": NORMALIZATION_VERSION_ID,
        },
    )
    assert priority.status_code == 200, priority.text

    retained_zone = create_zone(clients["specialist"]).json()
    retained_response = mutation(
        clients["specialist"],
        "POST",
        "/v1/scenarios",
        {
            "city_id": retained_zone["city_id"],
            "zone_id": retained_zone["id"],
            "name": "Municipal user plan",
            "base_revision_id": None,
            "initial_state": revision_body(retained_zone),
        },
    )
    assert retained_response.status_code == 201, retained_response.text
    with session() as db, db.begin():
        user = db.get(Principal, "00000000-0000-4000-8000-000000000002")
        revision = db.get(ScenarioRevision, target_scenario["current_revision_id"])
        job = enqueue(db, Access(db, user, None), revision, "calculate")
        target_job_id = job.id
    with session() as db, db.begin():
        token = claim(db, target_job_id)
    with session() as db, db.begin():
        complete(db, target_job_id, token, lambda _db, job: job.input_revision_id)

    with session() as db:
        plan = make_plan(db)
    assert [item["id"] for item in plan["scope"]["zones"]] == [target_zone["id"]]
    assert plan["scope"]["scenario_ids"] == [target_scenario["id"]]
    assert plan["scope"]["scenario_counts"]["zones"] == 1
    assert plan["scope"]["scenario_counts"]["jobs"] == 1
    assert plan["scope"]["scenario_counts"]["priority_results"] == 1

    with session() as db, db.begin():
        assert delete_scope(db, plan["scope"]) == {"datasets": 0, "zones": 1}
    with session() as db:
        assert db.scalar(
            text("SELECT count(*) FROM zones WHERE id=:id"), {"id": target_zone["id"]}
        ) == 0
        assert db.scalar(
            text("SELECT count(*) FROM scenarios WHERE id=:id"),
            {"id": target_scenario["id"]},
        ) == 0
        assert db.scalar(
            text("SELECT count(*) FROM zones WHERE id=:id"), {"id": retained_zone["id"]}
        ) == 1
        assert db.scalar(
            text("SELECT count(*) FROM scenarios WHERE id=:id"),
            {"id": retained_response.json()["id"]},
        ) == 1
        assert db.scalar(
            text("SELECT count(*) FROM priority_results WHERE id=:id"),
            {"id": priority.json()["id"]},
        ) == 0
        disabled = db.scalar(
            text(
                "SELECT count(*) FROM pg_trigger "
                "WHERE tgname IN ('zone_version_immutable','scenario_revision_immutable') "
                "AND tgenabled <> 'O'"
            )
        )
        assert disabled == 0
