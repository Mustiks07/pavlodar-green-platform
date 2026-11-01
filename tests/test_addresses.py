import json

import pytest

from packages.domain.contracts import validate
from services.worker.main import run_job
from tests.test_foundation import mutation
from tests.test_imports import create_dataset, start_import, upload
from tools.dev.seed import CITY_ID

pytestmark = pytest.mark.integration


def address_geojson():
    return json.dumps(
        {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "id": "address-1",
                    "properties": {"full_address": "ул. Ломова, 38"},
                    "geometry": {"type": "Point", "coordinates": [76.951, 52.281]},
                },
                {
                    "type": "Feature",
                    "id": "address-2",
                    "properties": {"street": "ул. Ломова", "house_number": "40"},
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [
                            [
                                [76.952, 52.281],
                                [76.953, 52.281],
                                [76.953, 52.282],
                                [76.952, 52.282],
                                [76.952, 52.281],
                            ]
                        ],
                    },
                },
                {
                    "type": "Feature",
                    "id": "address-yo",
                    "properties": {"address": "улица Ёлочная, 1"},
                    "geometry": {"type": "Point", "coordinates": [76.954, 52.283]},
                },
                {
                    "type": "Feature",
                    "id": "not-an-address",
                    "properties": {"name": "SYNTHETIC TEST building"},
                    "geometry": {"type": "Point", "coordinates": [76.955, 52.284]},
                },
                {
                    "type": "Feature",
                    "id": "outside-city",
                    "properties": {"address": "SYNTHETIC TEST outside, 1"},
                    "geometry": {"type": "Point", "coordinates": [70.0, 50.0]},
                },
            ],
        },
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode()


def publish_address_dataset(clients, *, access_level="public"):
    specialist = clients["specialist"]
    dataset = create_dataset(specialist, access_level=access_level)
    if access_level == "restricted":
        granted = mutation(
            clients["admin"],
            "POST",
            f"/v1/datasets/{dataset['id']}/grants",
            {
                "user_id": "00000000-0000-4000-8000-000000000001",
                "reason": "SYNTHETIC TEST admin publication review",
            },
        )
        assert granted.status_code == 201, granted.text
    ticket = upload(
        specialist,
        dataset["id"],
        address_geojson(),
        "application/geo+json",
        "synthetic-addresses.geojson",
    )
    job = start_import(specialist, dataset["id"], ticket, "geojson")
    run_job.run(job["id"])
    version_id = specialist.get(f"/v1/jobs/{job['id']}").json()["result_ref_id"]
    published = mutation(
        clients["admin"],
        "POST",
        f"/v1/dataset-versions/{version_id}/publish",
        {"reason": "SYNTHETIC TEST local address index"},
    )
    assert published.status_code == 200, published.text
    return dataset, version_id


def test_address_search_reports_missing_local_index(clients):
    missing = clients["viewer"].get("/v1/addresses", params={"city_id": CITY_ID, "q": "Лом"})
    assert missing.status_code == 503
    assert missing.json()["code"] == "address_index_unavailable"
    assert missing.json()["blockers"] == [
        {
            "code": "address_dataset_missing",
            "message": "Нужен опубликованный локальный адресный набор с лицензией и provenance",
            "required_inputs": ["DR-08"],
            "blocking": True,
        }
    ]
    assert clients["outsider"].get(
        "/v1/addresses", params={"city_id": CITY_ID, "q": "Лом"}
    ).status_code == 404


def test_address_search_is_versioned_fuzzy_and_paginated(clients):
    _, version_id = publish_address_dataset(clients)
    viewer = clients["viewer"]

    found = viewer.get("/v1/addresses", params={"city_id": CITY_ID, "q": "ломова"})
    assert found.status_code == 200, found.text
    validate("AddressResultPage", found.json())
    assert [item["label"] for item in found.json()["items"]] == [
        "ул. Ломова, 38",
        "ул. Ломова, 40",
    ]
    first = found.json()["items"][0]
    assert first["confidence"] == "high"
    assert first["position"] == {"type": "Point", "coordinates": [76.951, 52.281]}
    assert first["source_ref"] == {
        "dataset_version_id": version_id,
        "source_record_id": "address-1",
        "label": "SYNTHETIC TEST generic import",
        "uri": None,
    }

    fuzzy = viewer.get("/v1/addresses", params={"city_id": CITY_ID, "q": "ломва 38"})
    assert fuzzy.status_code == 200
    assert fuzzy.json()["items"][0]["label"] == "ул. Ломова, 38"

    normalized = viewer.get(
        "/v1/addresses", params={"city_id": CITY_ID, "q": "  ЕЛОЧНАЯ  "}
    )
    assert normalized.status_code == 200
    assert [item["label"] for item in normalized.json()["items"]] == ["улица Ёлочная, 1"]

    page_one = viewer.get(
        "/v1/addresses", params={"city_id": CITY_ID, "q": "лом", "limit": 1}
    )
    assert page_one.status_code == 200
    assert len(page_one.json()["items"]) == 1 and page_one.json()["next_cursor"]
    page_two = viewer.get(
        "/v1/addresses",
        params={
            "city_id": CITY_ID,
            "q": "лом",
            "limit": 1,
            "cursor": page_one.json()["next_cursor"],
        },
    )
    assert page_two.status_code == 200
    assert len(page_two.json()["items"]) == 1
    assert page_two.json()["items"][0]["id"] != page_one.json()["items"][0]["id"]

    bad_cursor = viewer.get(
        "/v1/addresses",
        params={
            "city_id": CITY_ID,
            "q": "елочная",
            "limit": 1,
            "cursor": page_one.json()["next_cursor"],
        },
    )
    assert bad_cursor.status_code == 422 and bad_cursor.json()["code"] == "invalid_cursor"

    empty = viewer.get("/v1/addresses", params={"city_id": CITY_ID, "q": "несуществующий"})
    assert empty.status_code == 200 and empty.json() == {"items": [], "next_cursor": None}
    outside = viewer.get("/v1/addresses", params={"city_id": CITY_ID, "q": "outside"})
    assert outside.status_code == 200 and outside.json()["items"] == []
    malformed = viewer.get(
        "/v1/addresses", params={"city_id": CITY_ID, "q": "лом", "cursor": "%%%"}
    )
    assert malformed.status_code == 422 and malformed.json()["code"] == "invalid_cursor"


def test_restricted_address_index_does_not_leak_to_viewer(clients):
    publish_address_dataset(clients, access_level="restricted")
    specialist = clients["specialist"].get(
        "/v1/addresses", params={"city_id": CITY_ID, "q": "ломова"}
    )
    assert specialist.status_code == 200 and len(specialist.json()["items"]) == 2
    viewer = clients["viewer"].get(
        "/v1/addresses", params={"city_id": CITY_ID, "q": "ломова"}
    )
    assert viewer.status_code == 503 and viewer.json()["code"] == "address_index_unavailable"
