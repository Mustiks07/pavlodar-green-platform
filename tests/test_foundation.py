import copy
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from packages.domain.contracts import validate
from services.api.db import engine, session
from services.api.models import AuditEvent, CityGrant, DatasetGrant, ScenarioRevision, ZoneVersion
from tools.dev.seed import CITY_ID

pytestmark = pytest.mark.integration


def mutation(client, method, path, body=None, key=None, etag=None):
    headers = {"Idempotency-Key": key or str(uuid4())}
    if etag:
        headers["If-Match"] = etag
    return client.request(method, path, json=body, headers=headers)


def zone_body():
    return {
        "city_id": CITY_ID,
        "name": "SYNTHETIC zone",
        "purpose": "park",
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                [[76.98, 52.28], [76.981, 52.28], [76.981, 52.281], [76.98, 52.281], [76.98, 52.28]]
            ],
        },
    }


def create_zone(client):
    response = mutation(client, "POST", "/v1/zones", zone_body())
    assert response.status_code == 201, response.text
    validate("Zone", response.json())
    return response


def revision_body(zone):
    return {
        "zone_version_id": zone["version_id"],
        "parent_revision_id": None,
        "dataset_version_ids": [],
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
        "comment": "SYNTHETIC TEST empty draft",
    }


def create_scenario(client):
    zone = create_zone(client).json()
    body = {
        "city_id": CITY_ID,
        "zone_id": zone["id"],
        "name": "SYNTHETIC scenario",
        "base_revision_id": None,
        "initial_state": revision_body(zone),
    }
    response = mutation(client, "POST", "/v1/scenarios", body)
    assert response.status_code == 201, response.text
    return zone, body, response


def test_readiness_matches_current_migration_head(clients):
    response = clients["viewer"].get("/health/ready")
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "ok"


def test_session_roles_csrf_origin_and_idor(clients):
    specialist = clients["specialist"]
    assert specialist.get("/v1/me").status_code == 200
    assert clients["outsider"].get(f"/v1/cities/{CITY_ID}").status_code == 404
    assert clients["outsider"].get("/v1/cities").json()["items"] == []
    assert mutation(clients["viewer"], "POST", "/v1/zones", zone_body()).status_code == 403
    assert (
        specialist.post(
            "/v1/zones", json=zone_body(), headers={"Origin": "https://evil.test"}
        ).status_code
        == 403
    )
    assert (
        specialist.post(
            "/v1/zones", json=zone_body(), headers={"X-CSRF-Token": "invalid"}
        ).status_code
        == 403
    )
    specialist.cookies.clear()
    response = specialist.get("/v1/me")
    assert response.status_code == 401
    assert response.headers["content-type"].startswith("application/problem+json")
    validate("Problem", response.json())


def test_persist_revision_conflict_and_database_immutability(clients):
    client = clients["specialist"]
    zone, body, created = create_scenario(client)
    scenario = created.json()
    assert clients["viewer"].get(f"/v1/scenarios/{scenario['id']}").status_code == 404
    assert clients["outsider"].get(f"/v1/scenarios/{scenario['id']}").status_code == 404
    original = client.get(f"/v1/scenario-revisions/{scenario['current_revision_id']}").json()
    append = {
        **body["initial_state"],
        "parent_revision_id": original["id"],
        "comment": "Second revision",
    }
    saved = mutation(
        client,
        "POST",
        f"/v1/scenarios/{scenario['id']}/revisions",
        append,
        etag=created.headers["etag"],
    )
    assert saved.status_code == 201, saved.text
    stale = mutation(
        client,
        "POST",
        f"/v1/scenarios/{scenario['id']}/revisions",
        append,
        etag=created.headers["etag"],
    )
    assert stale.status_code == 412
    assert stale.json()["current_revision_id"] == saved.json()["id"]
    engine().dispose()  # New connection pool; no in-memory state can satisfy subsequent reads.
    assert client.get(f"/v1/scenario-revisions/{original['id']}").json() == original
    current = client.get(f"/v1/scenarios/{scenario['id']}").json()
    assert current["current_revision_id"] == saved.json()["id"]
    with pytest.raises(DBAPIError), engine().begin() as conn:
        conn.execute(
            text("UPDATE scenario_revisions SET payload = payload WHERE id=:id"),
            {"id": original["id"]},
        )
    with session() as db:
        assert db.get(ZoneVersion, zone["version_id"]).payload["area_m2"] > 7000
        assert db.get(ScenarioRevision, original["id"]).payload["synthetic_inputs"] is True


def test_concurrent_idempotency_and_conflicting_payload(clients):
    client = clients["specialist"]
    key = str(uuid4())
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(
            pool.map(lambda _: mutation(client, "POST", "/v1/zones", zone_body(), key), range(2))
        )
    assert [r.status_code for r in responses] == [201, 201], [r.text for r in responses]
    assert responses[0].json() == responses[1].json()
    assert len(client.get("/v1/zones", params={"city_id": CITY_ID}).json()["items"]) == 1
    assert (
        mutation(client, "POST", "/v1/zones", {**zone_body(), "name": "different"}, key).status_code
        == 409
    )
    with session() as db, db.begin():
        grant = db.get(CityGrant, ("00000000-0000-4000-8000-000000000002", CITY_ID))
        db.delete(grant)
    assert mutation(client, "POST", "/v1/zones", zone_body(), key).status_code == 404


def test_concurrent_edits_have_one_winner(clients):
    client = clients["specialist"]
    created = create_zone(client)
    path = f"/v1/zones/{created.json()['id']}"
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(
            pool.map(
                lambda n: mutation(
                    client,
                    "PUT",
                    path,
                    {**zone_body(), "name": f"edit {n}"},
                    etag=created.headers["etag"],
                ),
                range(2),
            )
        )
    assert sorted(r.status_code for r in responses) == [200, 412], [r.text for r in responses]
    with session() as db:
        versions = list(db.scalars(select(ZoneVersion)))
        assert len(versions) == 2
        assert db.get(ZoneVersion, created.json()["version_id"]).payload == created.json()
    historical = client.get(f"/v1/zone-versions/{created.json()['version_id']}")
    assert historical.status_code == 200
    assert historical.json() == created.json()
    assert (
        clients["outsider"].get(f"/v1/zone-versions/{created.json()['version_id']}").status_code
        == 404
    )


def test_restricted_dataset_grants_are_not_implied_by_role(clients):
    body = {
        "city_id": CITY_ID,
        "name": "SYNTHETIC restricted source",
        "kind": "restrictions",
        "owner": "TEST",
        "license": "unknown",
        "access_level": "restricted",
        "source_uri": None,
    }
    created = mutation(clients["specialist"], "POST", "/v1/datasets", body)
    assert created.status_code == 201, created.text
    for role in ("admin", "viewer", "outsider"):
        assert clients[role].get(f"/v1/datasets/{created.json()['id']}/versions").status_code == 404
    result = clients["specialist"].get("/v1/datasets", params={"city_id": CITY_ID}).json()
    assert len(result["items"]) == 1

    principals = clients["admin"].get(
        f"/v1/cities/{CITY_ID}/principals", params={"limit": 2}
    )
    assert principals.status_code == 200, principals.text
    assert len(principals.json()["items"]) == 2
    assert principals.json()["next_cursor"]
    assert clients["specialist"].get(f"/v1/cities/{CITY_ID}/principals").status_code == 403

    grants_url = f"/v1/datasets/{created.json()['id']}/grants"
    listed = clients["admin"].get(grants_url)
    assert listed.status_code == 200, listed.text
    assert listed.json()["items"] == [
        {
            "dataset_id": created.json()["id"],
            "user_id": "00000000-0000-4000-8000-000000000002",
        }
    ]
    assert clients["specialist"].get(grants_url).status_code == 403
    assert mutation(
        clients["viewer"],
        "POST",
        grants_url,
        {
            "user_id": "00000000-0000-4000-8000-000000000003",
            "reason": "SYNTHETIC TEST forbidden",
        },
    ).status_code == 403
    wrong_city = mutation(
        clients["admin"],
        "POST",
        grants_url,
        {
            "user_id": "00000000-0000-4000-8000-000000000004",
            "reason": "SYNTHETIC TEST wrong city",
        },
    )
    assert wrong_city.status_code == 422 and wrong_city.json()["code"] == "grant_city_mismatch"

    key = str(uuid4())
    granted = mutation(
        clients["admin"],
        "POST",
        grants_url,
        {
            "user_id": "00000000-0000-4000-8000-000000000001",
            "reason": "SYNTHETIC TEST publication review",
        },
        key=key,
    )
    assert granted.status_code == 201, granted.text
    assert mutation(
        clients["admin"],
        "POST",
        grants_url,
        {
            "user_id": "00000000-0000-4000-8000-000000000001",
            "reason": "SYNTHETIC TEST publication review",
        },
        key=key,
    ).json() == granted.json()
    assert clients["admin"].get(f"/v1/datasets/{created.json()['id']}/versions").status_code == 200
    duplicate = mutation(
        clients["admin"],
        "POST",
        grants_url,
        {
            "user_id": "00000000-0000-4000-8000-000000000001",
            "reason": "SYNTHETIC TEST duplicate",
        },
    )
    assert duplicate.status_code == 409 and duplicate.json()["code"] == "grant_exists"

    revoked = mutation(
        clients["admin"],
        "DELETE",
        grants_url + "/00000000-0000-4000-8000-000000000001",
        {"reason": "SYNTHETIC TEST review complete"},
    )
    assert revoked.status_code == 200, revoked.text
    assert clients["admin"].get(f"/v1/datasets/{created.json()['id']}/versions").status_code == 404
    with session() as db:
        reasons = [
            event.payload["reason"]
            for event in db.scalars(select(AuditEvent))
            if event.payload["action"].startswith("dataset.grant_")
        ]
    assert reasons == ["SYNTHETIC TEST publication review", "SYNTHETIC TEST review complete"]

    with session() as db, db.begin():
        db.delete(
            db.get(DatasetGrant, ("00000000-0000-4000-8000-000000000002", created.json()["id"]))
        )
    assert (
        clients["specialist"].get("/v1/datasets", params={"city_id": CITY_ID}).json()["items"] == []
    )


@pytest.mark.parametrize("case", ["open_ring", "outside", "self_intersection", "extra_dimension"])
def test_invalid_geometry_is_rejected(clients, case):
    body = copy.deepcopy(zone_body())
    ring = body["geometry"]["coordinates"][0]
    if case == "open_ring":
        ring[-1] = [76.98, 52.2801]
    elif case == "outside":
        body["geometry"]["coordinates"] = [[[0, 0], [1, 0], [1, 1], [0, 0]]]
    elif case == "self_intersection":
        ring[1], ring[2] = ring[2], ring[1]
    else:
        ring[0].append(10)
    response = mutation(clients["specialist"], "POST", "/v1/zones", body)
    assert response.status_code == 422, response.text
    assert response.json()["field_errors"]
    assert response.json()["field_errors"][0]["path"].startswith("/geometry")


def test_pagination_filters_and_cursor_binding(clients):
    client = clients["specialist"]
    for _ in range(3):
        create_zone(client)
    params = {"city_id": CITY_ID, "limit": 2}
    first = client.get("/v1/zones", params=params).json()
    second = client.get("/v1/zones", params={**params, "cursor": first["next_cursor"]}).json()
    assert len(first["items"]) == 2 and len(second["items"]) == 1
    assert second["next_cursor"] is None
    assert (
        client.get(
            "/v1/zones", params={**params, "purpose": "park", "cursor": first["next_cursor"]}
        ).status_code
        == 422
    )
    assert client.get("/v1/zones", params={"city_id": CITY_ID, "limit": 201}).status_code == 422
    assert (
        client.get("/v1/zones", params={"city_id": CITY_ID, "bbox": "0,0,1,1"}).json()["items"]
        == []
    )
