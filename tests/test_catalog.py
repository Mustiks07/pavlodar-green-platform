import json
from uuid import uuid4

import pytest

from packages.domain.contracts import validate
from services.worker.main import run_job
from tests.test_foundation import mutation, revision_body, zone_body
from tests.test_imports import create_dataset, start_import, upload
from tools.dev.seed import CITY_ID

pytestmark = pytest.mark.integration

RULE_ID = "71000000-0000-4000-8000-000000000001"


def publish_catalog_source(clients):
    specialist = clients["specialist"]
    dataset = create_dataset(specialist, access_level="public", kind="catalog")
    content = b"taxon_key,source_note\nsynthetic-taxon,SYNTHETIC TEST catalog evidence\n"
    ticket = upload(specialist, dataset["id"], content, "text/csv", "synthetic-catalog.csv")
    job = start_import(specialist, dataset["id"], ticket, "csv")
    run_job.run(job["id"])
    version_id = specialist.get(f"/v1/jobs/{job['id']}").json()["result_ref_id"]
    published = mutation(
        clients["admin"],
        "POST",
        f"/v1/dataset-versions/{version_id}/publish",
        {"reason": "SYNTHETIC TEST catalog source"},
    )
    assert published.status_code == 200, published.text
    return version_id


def publish_rule(
    clients,
    *,
    review_status="expert_confirmed",
    rule_id=RULE_ID,
    parameter="plant_hard_constraints_reviewed",
    value=True,
    unit=None,
):
    specialist = clients["specialist"]
    dataset = create_dataset(specialist, access_level="public", kind="restrictions")
    content = json.dumps(
        {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "id": "synthetic-rule-source",
                    "properties": {
                        "record_type": "rule_version",
                        "id": rule_id,
                        "act_number": "SYNTHETIC TEST POLICY",
                        "clause": "test-clause",
                        "revision_date": "2026-10-30",
                        "parameter": parameter,
                        "value": value,
                        "unit": unit,
                        "applicability": "SYNTHETIC TEST city only",
                        "condition": None,
                        "review_status": review_status,
                        "source_status": "SYNTHETIC TEST fixture",
                        "superseded_by": None,
                    },
                    "geometry": {"type": "Point", "coordinates": [76.98, 52.28]},
                }
            ],
        },
        separators=(",", ":"),
    ).encode()
    ticket = upload(
        specialist,
        dataset["id"],
        content,
        "application/geo+json",
        "synthetic-rule.geojson",
    )
    job = start_import(specialist, dataset["id"], ticket, "geojson")
    run_job.run(job["id"])
    version_id = specialist.get(f"/v1/jobs/{job['id']}").json()["result_ref_id"]
    published = mutation(
        clients["admin"],
        "POST",
        f"/v1/dataset-versions/{version_id}/publish",
        {"reason": "SYNTHETIC TEST expert-confirmed rule"},
    )
    assert published.status_code == 200, published.text
    return version_id


def publish_stock(clients, plant_id):
    specialist = clients["specialist"]
    dataset = create_dataset(specialist, access_level="public", kind="stock")
    common = {
        "record_type": "stock_item",
        "plant_id": plant_id,
        "supplier": "SYNTHETIC TEST nursery",
        "size_description": "SYNTHETIC TEST container plant",
        "currency": "KZT",
        "observed_at": "2026-10-30T00:00:00Z",
        "supplier_city": "Pavlodar",
        "is_local_supply": True,
        "height_min_m": 1.0,
        "height_max_m": 1.5,
        "container": "C10",
        "root_system": "container",
        "tax_mode": "included",
        "applicability": "SYNTHETIC TEST only",
    }
    variants = [
        {
            "id": "stock-unknown",
            **common,
            "available_quantity": None,
            "unit_price": "1000.00",
            "availability": "listing_only",
            "stock_counted_at": None,
            "checked_at": "2026-10-30",
        },
        {
            "id": "stock-zero",
            **common,
            "available_quantity": 0,
            "unit_price": None,
            "availability": "not_in_stock",
            "stock_counted_at": "2026-10-30",
            "checked_at": "2026-10-30",
        },
        {
            "id": "stock-five",
            **common,
            "available_quantity": 5,
            "unit_price": "1200.00",
            "availability": "in_stock",
            "stock_counted_at": "2026-10-30",
            "checked_at": "2026-10-30",
        },
    ]
    content = json.dumps(
        {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "id": item.pop("id"),
                    "properties": item,
                    "geometry": {"type": "Point", "coordinates": [76.98, 52.28]},
                }
                for item in variants
            ],
        },
        separators=(",", ":"),
    ).encode()
    ticket = upload(
        specialist, dataset["id"], content, "application/geo+json", "synthetic-stock.geojson"
    )
    job = start_import(specialist, dataset["id"], ticket, "geojson")
    run_job.run(job["id"])
    version_id = specialist.get(f"/v1/jobs/{job['id']}").json()["result_ref_id"]
    published = mutation(
        clients["admin"],
        "POST",
        f"/v1/dataset-versions/{version_id}/publish",
        {"reason": "SYNTHETIC TEST stock registry"},
    )
    assert published.status_code == 200, published.text
    return version_id


def source_ref(version_id):
    return {
        "dataset_version_id": version_id,
        "source_record_id": "0",
        "label": "CLIENT LABEL MUST BE REPLACED",
        "uri": None,
    }


def plant_input(
    version_id,
    *,
    latin_name="Larix sibirica",
    russian_name="Лиственница сибирская",
    score=0.8,
    expert_status="approved",
    allergy="low",
    toxicity="absent",
    local_evidence="SYNTHETIC TEST expert fixture",
    sensitive_status="allowed",
    exclusion_reason=None,
    exclusion_basis=None,
):
    known = score is not None
    return {
        "latin_name": latin_name,
        "russian_name": russian_name,
        "cultivar": None,
        "stratum": "tree",
        "traits": [
            {
                "key": "drought_fit",
                "value_text": None,
                "value_number": score,
                "unit": "1",
                "status": "known" if known else "unknown",
                "source_refs": [source_ref(version_id)],
            }
        ],
        "allergy_risk": allergy,
        "toxicity_risk": toxicity,
        "expert_status": expert_status,
        "taxon_rank": "species",
        "local_evidence": local_evidence,
        "sensitive_site_status": sensitive_status,
        "exclusion_reason": exclusion_reason,
        "exclusion_basis": exclusion_basis,
        "review_reasons": [],
    }


def create_three_plants(clients, source_version):
    admin = clients["admin"]
    eligible = mutation(admin, "POST", "/v1/plants", plant_input(source_version))
    assert eligible.status_code == 201, eligible.text
    review = mutation(
        admin,
        "POST",
        "/v1/plants",
        plant_input(
            source_version,
            latin_name="SYNTHETIC pending species",
            russian_name="СИНТЕТИЧЕСКИЙ вид на проверке",
            score=None,
            expert_status="pending",
            allergy="unknown",
            toxicity="unknown",
            local_evidence=None,
            sensitive_status="requires_review",
        ),
    )
    assert review.status_code == 201, review.text
    excluded = mutation(
        admin,
        "POST",
        "/v1/plants",
        plant_input(
            source_version,
            latin_name="SYNTHETIC sensitive excluded",
            russian_name="СИНТЕТИЧЕСКИЙ исключённый вид",
            score=0.5,
            sensitive_status="excluded",
            exclusion_reason="SYNTHETIC TEST expert exclusion for schools",
            exclusion_basis="expert_decision",
        ),
    )
    assert excluded.status_code == 201, excluded.text
    return eligible.json()["id"], review.json()["id"], excluded.json()["id"]


def school_zone(client):
    created = mutation(client, "POST", "/v1/zones", {**zone_body(), "purpose": "school"})
    assert created.status_code == 201, created.text
    return created.json()


def test_catalog_snapshots_etag_search_and_rule_lineage(clients):
    source_version = publish_catalog_source(clients)
    rule_version = publish_rule(clients)
    eligible_id, review_id, excluded_id = create_three_plants(clients, source_version)

    listed = clients["viewer"].get("/v1/plants", params={"stratum": "tree", "limit": 10})
    assert listed.status_code == 200, listed.text
    assert len(listed.json()["items"]) == 3
    catalog_id = listed.json()["items"][0]["version_id"]
    assert {item["version_id"] for item in listed.json()["items"]} == {catalog_id}
    assert {item["id"] for item in listed.json()["items"]} == {
        eligible_id,
        review_id,
        excluded_id,
    }
    searched = clients["viewer"].get("/v1/plants", params={"q": "лиственница"})
    assert [item["id"] for item in searched.json()["items"]] == [eligible_id]

    current = clients["viewer"].get(f"/v1/plants/{eligible_id}")
    assert current.status_code == 200 and current.headers["etag"]
    assert current.json()["traits"][0]["source_refs"][0]["label"] == (
        "SYNTHETIC TEST generic import"
    )
    updated_body = plant_input(source_version, score=0.9)
    updated = mutation(
        clients["admin"],
        "PUT",
        f"/v1/plants/{eligible_id}",
        updated_body,
        etag=current.headers["etag"],
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["version_id"] != catalog_id
    stale = mutation(
        clients["admin"],
        "PUT",
        f"/v1/plants/{eligible_id}",
        updated_body,
        etag=current.headers["etag"],
    )
    assert stale.status_code == 412
    relisted = clients["viewer"].get("/v1/plants").json()["items"]
    assert {item["version_id"] for item in relisted} == {updated.json()["version_id"]}

    rule = clients["viewer"].get(f"/v1/rule-versions/{RULE_ID}")
    assert rule.status_code == 200, rule.text
    validate("RuleVersion", rule.json())
    assert rule.json()["source"]["dataset_version_id"] == rule_version
    assert rule.json()["source"]["source_record_id"] == "synthetic-rule-source"
    listed = clients["viewer"].get(
        "/v1/rule-versions", params={"city_id": CITY_ID, "usable": "true", "limit": 1}
    )
    assert listed.status_code == 200, listed.text
    assert [item["id"] for item in listed.json()["items"]] == [RULE_ID]
    validate("RuleVersionPage", listed.json())
    assert clients["viewer"].get(
        "/v1/rule-versions", params={"city_id": CITY_ID, "usable": "not-a-boolean"}
    ).status_code == 422
    assert mutation(clients["viewer"], "POST", "/v1/plants", plant_input(source_version)).status_code == 403


def test_recommendations_apply_hard_constraints_and_sourced_scores(clients):
    source_version = publish_catalog_source(clients)
    publish_rule(clients)
    eligible_id, review_id, excluded_id = create_three_plants(clients, source_version)
    catalog_id = clients["viewer"].get("/v1/plants").json()["items"][0]["version_id"]
    zone = school_zone(clients["specialist"])
    body = {
        "zone_version_id": zone["version_id"],
        "catalog_version_id": catalog_id,
        "rule_version_id": RULE_ID,
        "top_n": 3,
        "excluded_plant_ids": [],
        "locked_plant_ids": [],
        "weights": [{"factor": "drought_fit", "weight": 1.0}],
    }
    key = str(uuid4())
    response = mutation(clients["specialist"], "POST", "/v1/recommendations", body, key)
    assert response.status_code == 200, response.text
    validate("RecommendationResult", response.json())
    assert mutation(
        clients["specialist"], "POST", "/v1/recommendations", body, key
    ).json() == response.json()
    candidates = {item["plant_id"]: item for item in response.json()["candidates"]}
    assert candidates[eligible_id]["eligibility"] == "eligible"
    assert candidates[eligible_id]["score"] == 80.0
    assert candidates[eligible_id]["data_coverage"] == 1.0
    assert candidates[eligible_id]["contributions"][0]["source_refs"]
    assert candidates[review_id]["eligibility"] == "requires_review"
    assert candidates[review_id]["score"] is None
    assert {item["code"] for item in candidates[review_id]["blockers"]} >= {
        "plant_expert_review_required",
        "plant_safety_unknown",
        "plant_local_evidence_missing",
        "plant_trait_missing",
    }
    assert candidates[excluded_id]["eligibility"] == "excluded"
    assert candidates[excluded_id]["score"] is None
    assert candidates[excluded_id]["blockers"][0]["code"] == "plant_sensitive_site_excluded"

    current_review = clients["viewer"].get(f"/v1/plants/{review_id}")
    scored_review = mutation(
        clients["admin"],
        "PUT",
        f"/v1/plants/{review_id}",
        plant_input(
            source_version,
            latin_name="SYNTHETIC pending species",
            russian_name="СИНТЕТИЧЕСКИЙ вид на проверке",
            score=0.6,
            expert_status="pending",
            allergy="unknown",
            toxicity="unknown",
            local_evidence=None,
            sensitive_status="requires_review",
        ),
        etag=current_review.headers["etag"],
    )
    assert scored_review.status_code == 200, scored_review.text
    rescored = mutation(
        clients["specialist"],
        "POST",
        "/v1/recommendations",
        {**body, "catalog_version_id": scored_review.json()["version_id"]},
    )
    assert rescored.status_code == 200, rescored.text
    reviewed = next(
        item for item in rescored.json()["candidates"] if item["plant_id"] == review_id
    )
    assert reviewed["eligibility"] == "requires_review"
    assert reviewed["data_coverage"] == 1.0
    assert reviewed["score"] == 60.0
    assert reviewed["blockers"]

    invalid = mutation(
        clients["specialist"],
        "POST",
        "/v1/recommendations",
        {**body, "weights": [{"factor": "drought_fit", "weight": 0.0}]},
    )
    assert invalid.status_code == 422 and invalid.json()["code"] == "recommendation_weights_invalid"


def test_scenario_revision_validates_catalog_placement_and_exclusions(clients):
    source_version = publish_catalog_source(clients)
    publish_rule(clients)
    eligible_id, _, excluded_id = create_three_plants(clients, source_version)
    catalog_id = clients["viewer"].get("/v1/plants").json()["items"][0]["version_id"]
    specialist = clients["specialist"]
    zone = school_zone(specialist)
    initial = revision_body(zone)
    created = mutation(
        specialist,
        "POST",
        "/v1/scenarios",
        {
            "city_id": CITY_ID,
            "zone_id": zone["id"],
            "name": "SYNTHETIC TEST catalog placement",
            "base_revision_id": None,
            "initial_state": initial,
        },
    )
    assert created.status_code == 201, created.text
    scenario = created.json()
    base = {
        **initial,
        "parent_revision_id": scenario["current_revision_id"],
        "catalog_version_id": catalog_id,
        "rule_version_id": RULE_ID,
        "comment": "SYNTHETIC TEST sourced placement",
    }

    def placement(plant_id, coordinates):
        return {
            "id": str(uuid4()),
            "plant_id": plant_id,
            "stock_item_id": None,
            "position": {"type": "Point", "coordinates": coordinates},
            "quantity": 1,
            "planting_date": "2027-05-15",
            "locked": False,
            "initial_height_m": None,
            "initial_crown_radius_m": None,
            "dimension_basis": "unknown",
        }

    excluded = mutation(
        specialist,
        "POST",
        f"/v1/scenarios/{scenario['id']}/revisions",
        {**base, "placements": [placement(excluded_id, [76.9805, 52.2805])]},
        etag=created.headers["etag"],
    )
    assert excluded.status_code == 422 and excluded.json()["code"] == "placement_plant_excluded"
    outside = mutation(
        specialist,
        "POST",
        f"/v1/scenarios/{scenario['id']}/revisions",
        {**base, "placements": [placement(eligible_id, [77.0, 53.0])]},
        etag=created.headers["etag"],
    )
    assert outside.status_code == 422 and outside.json()["code"] == "placement_outside_zone"
    saved = mutation(
        specialist,
        "POST",
        f"/v1/scenarios/{scenario['id']}/revisions",
        {**base, "placements": [placement(eligible_id, [76.9805, 52.2805])]},
        etag=created.headers["etag"],
    )
    assert saved.status_code == 201, saved.text
    assert saved.json()["catalog_version_id"] == catalog_id
    assert saved.json()["rule_version_id"] == RULE_ID
    assert saved.json()["synthetic_inputs"] is True

    planning = mutation(
        specialist,
        "POST",
        "/v1/scenarios",
        {
            "city_id": CITY_ID,
            "zone_id": zone["id"],
            "name": "SYNTHETIC TEST draft placement before rule selection",
            "base_revision_id": None,
            "initial_state": initial,
        },
    )
    draft = mutation(
        specialist,
        "POST",
        f"/v1/scenarios/{planning.json()['id']}/revisions",
        {
            **initial,
            "parent_revision_id": planning.json()["current_revision_id"],
            "catalog_version_id": catalog_id,
            "rule_version_id": None,
            "placements": [placement(eligible_id, [76.9805, 52.2805])],
            "comment": "SYNTHETIC TEST visual planning before rule selection",
        },
        etag=planning.headers["etag"],
    )
    assert draft.status_code == 201, draft.text
    assert draft.json()["placements"] and draft.json()["rule_version_id"] is None


def test_stock_registry_preserves_unknown_zero_and_exact_revision_input(clients):
    source_version = publish_catalog_source(clients)
    publish_rule(clients)
    plant_id, _, _ = create_three_plants(clients, source_version)
    catalog_id = clients["viewer"].get("/v1/plants").json()["items"][0]["version_id"]
    stock_version = publish_stock(clients, plant_id)

    listed = clients["viewer"].get("/v1/stock", params={"plant_id": plant_id})
    assert listed.status_code == 200, listed.text
    validate("StockItemPage", listed.json())
    by_availability = {item["availability"]: item for item in listed.json()["items"]}
    assert by_availability["listing_only"]["available_quantity"] is None
    assert by_availability["not_in_stock"]["available_quantity"] == 0
    assert by_availability["in_stock"]["available_quantity"] == 5
    selected = by_availability["in_stock"]

    specialist = clients["specialist"]
    zone = school_zone(specialist)
    initial = revision_body(zone)
    created = mutation(
        specialist,
        "POST",
        "/v1/scenarios",
        {
            "city_id": CITY_ID,
            "zone_id": zone["id"],
            "name": "SYNTHETIC TEST stock freeze",
            "base_revision_id": None,
            "initial_state": initial,
        },
    )
    placement = {
        "id": str(uuid4()),
        "plant_id": plant_id,
        "stock_item_id": selected["id"],
        "position": {"type": "Point", "coordinates": [76.9805, 52.2805]},
        "quantity": 2,
        "planting_date": "2027-05-15",
        "locked": False,
        "initial_height_m": None,
        "initial_crown_radius_m": None,
        "dimension_basis": "unknown",
    }
    body = {
        **initial,
        "parent_revision_id": created.json()["current_revision_id"],
        "catalog_version_id": catalog_id,
        "rule_version_id": RULE_ID,
        "placements": [placement],
        "comment": "SYNTHETIC TEST exact stock version",
    }
    missing_source = mutation(
        specialist,
        "POST",
        f"/v1/scenarios/{created.json()['id']}/revisions",
        body,
        etag=created.headers["etag"],
    )
    assert missing_source.status_code == 422
    assert missing_source.json()["code"] == "stock_item_unavailable"
    saved = mutation(
        specialist,
        "POST",
        f"/v1/scenarios/{created.json()['id']}/revisions",
        {**body, "dataset_version_ids": [stock_version]},
        etag=created.headers["etag"],
    )
    assert saved.status_code == 201, saved.text
    assert saved.json()["placements"][0]["stock_item_id"] == selected["id"]
