"""Actual HTTP/OIDC capture after a separately performed service restart."""

import json
from pathlib import Path
from uuid import uuid4

import httpx

from packages.domain.contracts import validate
from services.api.research import CITY_ID
from tools.dev.smoke_oidc import login

ROOT = Path(__file__).parents[2]


def capture(name, schema, data):
    validate(schema, data)
    (ROOT / f"contracts/fixtures/research_{name}.json").write_text(
        json.dumps(
            {
                "schema": schema,
                "expected_valid": True,
                "fixture_only": True,
                "origin": "Actual local API response from checksum-verified public research; not organizer data or approval",
                "data": data,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def main():
    with httpx.Client(
        base_url="http://localhost:8001", timeout=30, follow_redirects=False
    ) as client:
        assert client.get("/health/ready").status_code == 200
        login(client, "admin")
        city = client.get(f"/v1/cities/{CITY_ID}")
        assert city.status_code == 200
        assert city.json()["boundary_status"] == "working"
        capture("city", "City", city.json())
        datasets = client.get("/v1/datasets", params={"city_id": CITY_ID})
        assert datasets.status_code == 200
        assert len(datasets.json()["items"]) == 7
        capture("datasets", "DatasetPage", datasets.json())
        readiness = client.get("/v1/source-readiness", params={"city_id": CITY_ID})
        assert readiness.status_code == 200, readiness.text
        assert len(readiness.json()["items"]) == 7
        readiness_items = readiness.json()["items"]
        assert all(
            item["readiness_state"] == "research_unverified"
            and item["dataset_version_id"]
            and item["review_reasons"]
            and item["record_count"] is not None
            for item in readiness_items
        )
        by_request = {item["data_request_id"]: item for item in readiness_items}
        assert set(by_request) == {f"DR-{number:02}" for number in range(1, 8)}
        assert {key: item["content_kind"] for key, item in by_request.items()} == {
            "DR-01": "vector",
            "DR-02": "table",
            "DR-03": "legal_text",
            "DR-04": "table",
            "DR-05": "table",
            "DR-06": "mixed",
            "DR-07": "table",
        }
        assert "110 зданий" in by_request["DR-06"]["applicability"]
        validate("SourceReadinessPage", readiness.json())
        versions = []
        for dataset in datasets.json()["items"]:
            listed = client.get(f"/v1/datasets/{dataset['id']}/versions")
            assert listed.status_code == 200, listed.text
            version = listed.json()["items"][0]
            assert version["status"] == "needs_review"
            report = client.get(f"/v1/dataset-versions/{version['id']}/quality")
            assert report.status_code == 200, report.text
            assert not report.json()["publish_allowed"]
            capture(dataset["name"][:5].lower() + "_quality", "QualityReport", report.json())
            denied = client.post(
                f"/v1/dataset-versions/{version['id']}/publish",
                json={"reason": "Integration check: research must not auto-publish"},
                headers={"Idempotency-Key": str(uuid4())},
            )
            assert denied.status_code == 422 and denied.json()["blockers"]
            versions.append(version["id"])
        result = {
            "passed": True,
            "city_id": CITY_ID,
            "version_ids": versions,
            "real_http_oidc": True,
            "quality_reports_read": 7,
            "publication_denials": 7,
            "source_readiness_rows": 7,
            "source_readiness_requests": {
                key: {
                    "content_kind": value["content_kind"],
                    "record_count": value["record_count"],
                }
                for key, value in sorted(by_request.items())
            },
            "organizer_data_received": False,
            "acceptance_met": False,
            "contract_version": "1.1.0",
        }
        (ROOT / "docs/evidence/research_api.json").write_text(
            json.dumps(result, indent=2) + "\n", encoding="utf-8"
        )
        print(json.dumps(result))


if __name__ == "__main__":
    main()
