import json
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError

from packages.domain.contracts import validate
from packages.domain.cost import calculate_cost
from packages.domain.errors import DomainError, gap
from services.api.db import session
from services.api.models import (
    City,
    CityGrant,
    Dataset,
    DatasetVersion,
    ResearchFile,
    ResearchQuality,
    ResearchReceipt,
    StagingIdentity,
    StagingOccurrence,
    StagingRecord,
)
from services.api.research import CITY_ID, import_delivery, verified_files

ROOT = Path(__file__).parents[1]
ADMIN = "00000000-0000-4000-8000-000000000001"
SPECIALIST = "00000000-0000-4000-8000-000000000002"
VIEWER = "00000000-0000-4000-8000-000000000003"


def imported():
    with session() as db, db.begin():
        return import_delivery(db, ROOT, ADMIN, [SPECIALIST])


def records(db, namespace):
    return list(
        db.scalars(
            select(StagingRecord)
            .join(StagingIdentity)
            .where(StagingIdentity.namespace == namespace)
        )
    )


def counts(db):
    return {
        model.__tablename__: db.scalar(select(func.count()).select_from(model))
        for model in [
            Dataset,
            DatasetVersion,
            ResearchFile,
            ResearchReceipt,
            StagingIdentity,
            StagingRecord,
            StagingOccurrence,
            ResearchQuality,
        ]
    }


def test_delivery_idempotency_raw_lineage_and_meaning(database):
    result = imported()
    with session() as db:
        first_counts = counts(db)
        city = db.get(City, CITY_ID)
        assert not city.synthetic
        assert city.payload["boundary_status"] == "working"
        assert db.get(DatasetVersion, city.payload["boundary_version_id"])
        stock = records(db, "stock")
        assert len(stock) == 4
        occurrences = list(
            db.scalars(select(StagingOccurrence).where(StagingOccurrence.table_name == "stock.csv"))
        )
        assert len(occurrences) == 8
        assert len({r.record_id for r in occurrences}) == 4
        assert all(r.source_record_ids for r in occurrences)
        assert any(r.raw["quantity"] is None for r in stock)
        assert any(r.raw["quantity"] == 0 for r in stock)
        assert all(r.raw["stock_count_date"] is None for r in stock)
        assert sum(r.interpretation["local_quote"] for r in stock) == 3
        assert all(not r.interpretation["reservable"] for r in stock)
        taxa = records(db, "taxon")
        assert len(taxa) == 9 and sum(r.raw["rank"] == "genus" for r in taxa) == 3
        assert all(r.interpretation["eligibility"] == "needs_review" for r in taxa)
        pine = next(
            r
            for r in records(db, "DR-02:traits.csv")
            if r.raw["record_id"] == "pinus_sylvestris:adult_height"
        )
        assert pine.raw["unit"] == "ft" and pine.raw["lower"] == 30
        assert pine.interpretation["conversion"]["lower"] == "9.1440"
        assert pine.interpretation["growth_curve_available"] is False
        for r in records(db, "DR-05:rates.csv") + records(db, "DR-03:rules.csv"):
            assert not r.interpretation["active_for_calculation"]
        assert len(records(db, "DR-06:buildings.geojson")) == 110
        assert all(
            r.raw["properties"]["height_basis"] == "recorded_unverified"
            for r in records(db, "DR-06:buildings.geojson")
        )
        assert len(records(db, "DR-06:weather.csv")) == 168
        assert len(records(db, "DR-06:imagery_catalog.csv")) == 82
        assert all(r.raw["value"] is None for r in records(db, "DR-06:coefficients.csv"))
        assert not records(db, "DR-04:cohorts.csv")
        assert all(not r.raw["training_eligible"] for r in records(db, "DR-04:reported_events.csv"))
        assert all(
            v.status == "needs_review" and v.payload["observed_at"] is None
            for v in db.scalars(select(DatasetVersion))
        )
        assert all(
            v.payload["readiness_state"] == "research_unverified"
            and v.payload["checked_at"] == "2026-10-29"
            and v.payload["review_reasons"][0]["blocking"]
            for v in db.scalars(select(DatasetVersion))
        )
        assert all(d.current_version_id is None for d in db.scalars(select(Dataset)))
    again = imported()
    assert not again["created"] and result["receipt_id"] == again["receipt_id"]
    with session() as db:
        assert counts(db) == first_counts


def test_existing_delivery_can_onboard_an_additional_city_user(database):
    imported()
    with session() as db:
        assert db.get(CityGrant, (VIEWER, CITY_ID)) is None
    with session() as db, db.begin():
        result = import_delivery(db, ROOT, ADMIN, [VIEWER])
    assert not result["created"]
    with session() as db:
        assert db.get(CityGrant, (VIEWER, CITY_ID))


def test_quality_api_authorization_and_publication_block(clients):
    result = imported()
    version = result["dataset_versions"]["DR-05"]
    url = f"/v1/dataset-versions/{version}/quality"
    response = clients["specialist"].get(url)
    assert response.status_code == 200, response.text
    validate("QualityReport", response.json())
    assert response.json()["publish_allowed"] is False
    partial = clients["specialist"].get(url, params={"limit": 2}).json()
    assert len(partial["issues"]) == 2 and partial["issues_truncated"]
    following = clients["specialist"].get(
        url, params={"limit": 2, "cursor": partial["issues_next_cursor"]}
    )
    assert following.status_code == 200
    assert following.json()["issues"] == response.json()["issues"][2:4]
    assert (
        clients["specialist"]
        .get(url, params={"limit": 3, "cursor": partial["issues_next_cursor"]})
        .status_code
        == 422
    )
    assert any(i["source_record_id"] == "WATER-2026-PDF" for i in response.json()["issues"])
    assert clients["outsider"].get(url).status_code == 404
    assert clients["viewer"].get(url).status_code == 403
    denied = clients["admin"].post(
        f"/v1/dataset-versions/{version}/publish",
        json={"reason": "TEST attempt to promote research"},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert denied.status_code == 422, denied.text
    assert denied.json()["blockers"][0]["blocking"]
    with session() as db:
        assert db.get(DatasetVersion, version).status == "needs_review"


def test_source_readiness_api_is_versioned_and_grant_filtered(clients):
    result = imported()
    response = clients["specialist"].get(
        "/v1/source-readiness", params={"city_id": CITY_ID, "limit": 3}
    )
    assert response.status_code == 200, response.text
    first = response.json()
    validate("SourceReadinessPage", first)
    assert len(first["items"]) == 3 and first["next_cursor"]
    assert all(item["readiness_state"] == "research_unverified" for item in first["items"])
    dr06 = clients["specialist"].get(
        "/v1/source-readiness",
        params={
            "city_id": CITY_ID,
            "dataset_id": next(
                item["dataset_id"]
                for item in first["items"]
                if item["dataset_version_id"] in result["dataset_versions"].values()
            ),
        },
    )
    assert dr06.status_code == 200
    assert (
        clients["outsider"].get("/v1/source-readiness", params={"city_id": CITY_ID}).status_code
        == 404
    )


def test_staging_immutable_and_non_admin_import(database):
    imported()
    with pytest.raises(DBAPIError), session() as db, db.begin():
        db.execute(text("UPDATE staging_records SET raw='{}'::jsonb"))
    with pytest.raises(DomainError), session() as db, db.begin():
        import_delivery(db, ROOT, SPECIALIST)


def test_failed_import_rolls_back_receipt(database):
    with pytest.raises(RuntimeError), session() as db, db.begin():
        import_delivery(db, ROOT, ADMIN)
        raise RuntimeError("Test interruption before transaction commit")
    with session() as db:
        assert db.scalar(select(func.count()).select_from(ResearchReceipt)) == 0
        assert db.scalar(select(func.count()).select_from(StagingRecord)) == 0
    assert imported()["created"]


def test_delivery_checksums_reject_tampering(tmp_path):
    import shutil

    shutil.copytree(ROOT / "research/data", tmp_path / "research/data")
    path = tmp_path / "research/data/DR-05/records.json"
    path.write_text("{}", encoding="utf-8")
    with pytest.raises(ValueError, match="checksum mismatch"):
        verified_files(tmp_path)


def test_partial_cost_real_quote_explicit_test_quantity():
    # TEST assumption: two units. Source quotation is real; no rate activation implied.
    quote = json.loads((ROOT / "research/data/DR-05/records.json").read_text(encoding="utf-8"))[
        "stock.csv"
    ][0]
    material = {
        "id": str(uuid4()),
        "category": "material",
        "description": "TEST selected quotation",
        "quantity": 2,
        "unit": "piece",
        "unit_price": quote["price"],
        "subtotal": None,
        "year": 0,
        "rate_version_id": None,
        "formula": "pending",
        "source_refs": [],
        "tax_mode": "unknown",
        "price_observed_at": None,
        "rate_status": "unverified",
    }
    missing = {
        **material,
        "id": str(uuid4()),
        "category": "planting",
        "description": "Planting labor",
        "unit_price": None,
    }
    result = calculate_cost(
        [material, missing], [gap("tax_unknown", "Supplier tax treatment unresolved", "DR-05")]
    )
    from decimal import Decimal

    assert Decimal(result["known_subtotal"]) == Decimal(quote["price"]) * 2
    assert result["total"] is None and result["status"] == "incomplete"
    assert result["lines"][1]["subtotal"] is None
    assert any(g["code"] == "missing_rate" for g in result["data_gaps"])


def test_critical_data_blocks_approval_but_allows_review_and_return(clients):
    from tests.test_foundation import create_scenario, mutation

    client = clients["specialist"]
    _, _, created = create_scenario(client)
    scenario = created.json()
    url = f"/v1/scenarios/{scenario['id']}/transitions"
    body = {
        "target_status": "in_review",
        "reason": "TEST specialist review",
        "revision_id": scenario["current_revision_id"],
    }
    key = str(uuid4())
    review = mutation(client, "POST", url, body, key=key, etag=created.headers["etag"])
    assert review.status_code == 200, review.text
    assert review.json()["status"] == "in_review"
    assert (
        mutation(client, "POST", url, body, key=key, etag=created.headers["etag"]).json()
        == review.json()
    )
    approval = {**body, "target_status": "approved"}
    assert mutation(client, "POST", url, approval, etag=review.headers["etag"]).status_code == 403
    blocked = mutation(clients["admin"], "POST", url, approval, etag=review.headers["etag"])
    assert blocked.status_code == 422, blocked.text
    assert {g["code"] for g in blocked.json()["blockers"]} >= {
        "safety_inputs_missing",
        "approved_calculation_missing",
    }
    assert client.get(f"/v1/scenarios/{scenario['id']}").json()["status"] == "in_review"
    back = {**body, "target_status": "draft"}
    assert mutation(client, "POST", url, back, etag=created.headers["etag"]).status_code == 412
    assert mutation(client, "POST", url, back, etag=review.headers["etag"]).status_code == 200
