from uuid import uuid4

import pytest

from packages.domain.contracts import validate
from services.api.db import session
from services.api.models import Dataset, DatasetGrant, Scenario
from tests.test_calculations import setup_revision
from tests.test_foundation import mutation

pytestmark = pytest.mark.integration

SPECIALIST_ID = "00000000-0000-4000-8000-000000000002"


def fast(clients, revision_id, seed):
    response = mutation(
        clients["specialist"],
        "POST",
        "/v1/calculations/fast",
        {
            "scenario_revision_id": revision_id,
            "mode": "fast",
            "include_modules": ["cost", "survival"],
            "seed": seed,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["snapshot"]


def listing(client, revision_id, **params):
    return client.get("/v1/calculations", params={"scenario_revision_id": revision_id, **params})


def test_list_calculations_exact_revision_cursor_and_acl(clients):
    scenario, revision, saved, _ = setup_revision(clients, with_model=True)
    revision_id = saved.json()["id"]
    created = [fast(clients, revision_id, seed) for seed in (1, 2, 3)]
    specialist = clients["specialist"]

    first = listing(specialist, revision_id, limit=2)
    assert first.status_code == 200, first.text
    validate("CalculationSnapshotPage", first.json())
    assert len(first.json()["items"]) == 2 and first.json()["next_cursor"]
    cursor = first.json()["next_cursor"]
    second = listing(specialist, revision_id, limit=2, cursor=cursor)
    assert second.status_code == 200 and second.json()["next_cursor"] is None
    assert listing(specialist, revision_id, limit=2, cursor=cursor).json() == second.json()
    pages = first.json()["items"] + second.json()["items"]
    assert sorted(item["id"] for item in pages) == sorted(item["id"] for item in created)
    for item in pages:
        assert item["scenario_revision_id"] == revision_id
        assert item == specialist.get(f"/v1/calculations/{item['id']}").json()
        # A missing rate stays unknown; it is never served as a zero total.
        assert item["cost"]["status"] == "incomplete" and item["cost"]["total"] is None
        assert item["is_stale"] is False

    child = mutation(
        specialist,
        "POST",
        f"/v1/scenarios/{scenario['id']}/revisions",
        {**revision, "parent_revision_id": revision_id, "comment": "SYNTHETIC TEST child"},
        etag=specialist.get(f"/v1/scenarios/{scenario['id']}").headers["etag"],
    )
    assert child.status_code == 201, child.text
    child_snapshot = fast(clients, child.json()["id"], 4)
    parent_items = listing(specialist, revision_id, limit=200).json()["items"]
    assert child_snapshot["id"] not in {item["id"] for item in parent_items}
    assert all(item["is_stale"] for item in parent_items)
    child_items = listing(specialist, child.json()["id"]).json()["items"]
    assert [item["id"] for item in child_items] == [child_snapshot["id"]]

    # Cursors are bound to the user and the exact filters.
    assert listing(specialist, revision_id, cursor="not-a-cursor").status_code == 422
    other = listing(specialist, child.json()["id"], limit=2, cursor=cursor)
    assert other.status_code == 422 and other.json()["code"] == "invalid_cursor"
    assert listing(specialist, revision_id, limit=3, cursor=cursor).status_code == 422
    assert listing(clients["admin"], revision_id, limit=2, cursor=cursor).status_code == 422

    # IDOR: other cities, unknown revisions and unapproved drafts reveal nothing.
    assert listing(clients["outsider"], revision_id).status_code == 404
    assert listing(specialist, str(uuid4())).status_code == 404
    assert listing(clients["viewer"], revision_id).status_code == 404
    assert specialist.get("/v1/calculations").status_code == 422
    assert listing(specialist, "not-a-uuid").status_code == 422


def test_list_calculations_follows_restricted_dataset_grants(clients):
    scenario, _, saved, _ = setup_revision(clients, with_model=True)
    revision_id = saved.json()["id"]
    snapshot = fast(clients, revision_id, 9)
    model_dataset_id = saved.json()["dataset_version_ids"][0]
    with session() as db, db.begin():
        from services.api.models import DatasetVersion

        dataset = db.get(Dataset, db.get(DatasetVersion, model_dataset_id).dataset_id)
        dataset.access_level = "restricted"
        dataset_id = dataset.id
        db.merge(DatasetGrant(user_id=SPECIALIST_ID, dataset_id=dataset_id))
        stored = db.get(Scenario, scenario["id"])
        stored.status = "approved"
        stored.payload = {**stored.payload, "status": "approved"}

    allowed = listing(clients["specialist"], revision_id)
    assert allowed.status_code == 200, allowed.text
    assert [item["id"] for item in allowed.json()["items"]] == [snapshot["id"]]
    # The viewer can see the approved scenario but holds no grant for the frozen model data.
    assert listing(clients["viewer"], revision_id).status_code == 404

    revoked = mutation(
        clients["admin"],
        "DELETE",
        f"/v1/datasets/{dataset_id}/grants/{SPECIALIST_ID}",
        {"reason": "SYNTHETIC TEST snapshot list access revoked"},
    )
    assert revoked.status_code == 200, revoked.text
    assert listing(clients["specialist"], revision_id).status_code == 404
    assert clients["specialist"].get(f"/v1/calculations/{snapshot['id']}").status_code == 404
