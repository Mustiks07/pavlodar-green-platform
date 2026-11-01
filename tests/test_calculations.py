import json
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from packages.domain.contracts import validate
from services.api.db import engine
from services.worker.main import run_job
from tests.test_catalog import RULE_ID, plant_input, publish_catalog_source, publish_rule
from tests.test_foundation import create_scenario, mutation
from tests.test_imports import create_dataset, start_import, upload
from tools.dev.seed import CITY_ID

pytestmark = pytest.mark.integration


def publish_rate_source(clients):
    specialist = clients["specialist"]
    dataset = create_dataset(specialist, access_level="public", kind="rates")
    content = b"category,unit,price\nplant_material,piece,10.01\n"
    ticket = upload(specialist, dataset["id"], content, "text/csv", "synthetic-rates.csv")
    job = start_import(specialist, dataset["id"], ticket, "csv")
    run_job.run(job["id"])
    version_id = specialist.get(f"/v1/jobs/{job['id']}").json()["result_ref_id"]
    published = mutation(
        clients["admin"],
        "POST",
        f"/v1/dataset-versions/{version_id}/publish",
        {"reason": "SYNTHETIC TEST rate evidence"},
    )
    assert published.status_code == 200, published.text
    return version_id


def publish_survival_model(
    clients, *, calibration_status="expert_confirmed", expert_status="approved"
):
    specialist = clients["specialist"]
    dataset = create_dataset(specialist, access_level="public", kind="models")
    content = json.dumps(
        {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "id": "synthetic-expert-model",
                    "properties": {
                        "record_type": "survival_model",
                        "model_kind": "expert_rules",
                        "calibration_status": calibration_status,
                        "applicability": "SYNTHETIC TEST pipeline only",
                        "qualitative_confidence": "low",
                        "points": [
                            {"year": 1, "probability": 0.8, "lower": 0.6, "upper": 0.9},
                            {"year": 2, "probability": 0.7, "lower": 0.5, "upper": 0.85},
                            {"year": 3, "probability": 0.6, "lower": 0.4, "upper": 0.8},
                        ],
                        "checked_at": "2026-10-30",
                        "expert_status": expert_status,
                    },
                    "geometry": {"type": "Point", "coordinates": [76.98, 52.28]},
                }
            ],
        },
        separators=(",", ":"),
    ).encode()
    ticket = upload(
        specialist, dataset["id"], content, "application/geo+json", "synthetic-model.geojson"
    )
    job = start_import(specialist, dataset["id"], ticket, "geojson")
    run_job.run(job["id"])
    version_id = specialist.get(f"/v1/jobs/{job['id']}").json()["result_ref_id"]
    published = mutation(
        clients["admin"],
        "POST",
        f"/v1/dataset-versions/{version_id}/publish",
        {"reason": "SYNTHETIC TEST expert survival model"},
    )
    assert published.status_code == 200, published.text
    listed = clients["viewer"].get(
        "/v1/model-versions", params={"city_id": CITY_ID, "usable": "true"}
    )
    assert listed.status_code == 200, listed.text
    validate("SurvivalModelVersionPage", listed.json())
    model = next(
        item
        for item in listed.json()["items"]
        if any(ref["dataset_version_id"] == version_id for ref in item["source_refs"])
    )
    return version_id, model


def create_rate(clients, version_id, *, category="plant_material", unit_price="10.01"):
    response = mutation(
        clients["admin"],
        "POST",
        "/v1/rates",
        {
            "city_id": CITY_ID,
            "category": category,
            "unit": "piece",
            "unit_price": unit_price,
            "currency": "KZT",
            "valid_from": "2026-01-01",
            "tax_mode": "included",
            "source_refs": [
                {
                    "dataset_version_id": version_id,
                    "source_record_id": "0",
                    "label": "CLIENT LABEL MUST BE REPLACED",
                    "uri": None,
                }
            ],
            "valid_to": None,
            "price_observed_at": "2026-10-29",
            "checked_at": "2026-10-30",
            "applicability_status": "current",
            "included": f"SYNTHETIC TEST {category} only",
            "excluded": "all other cost categories",
        },
    )
    assert response.status_code == 201, response.text
    validate("Rate", response.json())
    return response.json()


def setup_revision(
    clients,
    *,
    with_rate=True,
    with_model=False,
    model_kwargs=None,
    rule_status="expert_confirmed",
):
    catalog_source = publish_catalog_source(clients)
    publish_rule(clients, review_status=rule_status)
    plant = mutation(clients["admin"], "POST", "/v1/plants", plant_input(catalog_source))
    assert plant.status_code == 201, plant.text
    rate = create_rate(clients, publish_rate_source(clients)) if with_rate else None
    model_version, model = (
        publish_survival_model(clients, **(model_kwargs or {}))
        if with_model
        else (None, None)
    )
    _, body, created = create_scenario(clients["specialist"])
    scenario = created.json()
    placement = {
        "id": str(uuid4()),
        "plant_id": plant.json()["id"],
        "stock_item_id": None,
        "position": {"type": "Point", "coordinates": [76.9805, 52.2805]},
        "quantity": 3,
        "planting_date": "2027-05-15",
        "locked": False,
        "initial_height_m": None,
        "initial_crown_radius_m": None,
        "dimension_basis": "unknown",
    }
    revision = {
        **body["initial_state"],
        "parent_revision_id": scenario["current_revision_id"],
        "catalog_version_id": plant.json()["version_id"],
        "rate_version_id": rate["version_id"] if rate else None,
        "model_version_id": model["id"] if model else None,
        "dataset_version_ids": [model_version] if model_version else [],
        "rule_version_id": RULE_ID,
        "placements": [placement],
        "comment": "SYNTHETIC TEST calculable revision",
    }
    saved = mutation(
        clients["specialist"],
        "POST",
        f"/v1/scenarios/{scenario['id']}/revisions",
        revision,
        etag=created.headers["etag"],
    )
    assert saved.status_code == 201, saved.text
    return scenario, revision, saved, rate


def test_fast_calculation_persists_decimal_snapshot_manifest_and_staleness(clients):
    scenario, revision, saved, rate = setup_revision(clients)
    key = str(uuid4())
    body = {
        "scenario_revision_id": saved.json()["id"],
        "mode": "fast",
        "include_modules": ["cost"],
        "seed": 17,
    }
    response = mutation(clients["specialist"], "POST", "/v1/calculations/fast", body, key=key)
    assert response.status_code == 200, response.text
    validate("FastCalculationResponse", response.json())
    snapshot = response.json()["snapshot"]
    assert snapshot["status"] == "partial"
    assert snapshot["cost"]["status"] == "incomplete"
    assert snapshot["cost"]["known_subtotal"] == "30.03"
    assert snapshot["cost"]["total"] is None
    assert {item["code"] for item in snapshot["cost"]["data_gaps"]} >= {
        "replacement_model_missing",
        "risk_reserve_rate_missing",
    }
    assert snapshot["cost"]["lines"][0]["unit_price"] == "10.01"
    assert snapshot["cost"]["lines"][0]["rate_version_id"] == rate["version_id"]
    repeated = mutation(
        clients["specialist"], "POST", "/v1/calculations/fast", body, key=key
    )
    assert repeated.json() == response.json()

    manifest = clients["specialist"].get(snapshot["manifest_url"])
    assert manifest.status_code == 200, manifest.text
    validate("SourceManifest", manifest.json())
    assert manifest.json()["input_hash"] == snapshot["input_hash"]
    assert manifest.json()["rate_version_ids"] == [rate["version_id"]]
    assert len(manifest.json()["output_hash"]) == 64

    next_revision = {
        **revision,
        "parent_revision_id": saved.json()["id"],
        "comment": "SYNTHETIC TEST makes old calculation stale",
    }
    newer = mutation(
        clients["specialist"],
        "POST",
        f"/v1/scenarios/{scenario['id']}/revisions",
        next_revision,
        etag=saved.headers["etag"],
    )
    assert newer.status_code == 201, newer.text
    old = clients["specialist"].get(f"/v1/calculations/{snapshot['id']}")
    assert old.status_code == 200 and old.json()["is_stale"] is True
    assert old.json()["cost"] == snapshot["cost"]
    assert clients["outsider"].get(f"/v1/calculations/{snapshot['id']}").status_code == 404

    with pytest.raises(DBAPIError), engine().begin() as connection:
        connection.execute(
            text("UPDATE calculation_snapshots SET payload=payload WHERE id=:id"),
            {"id": snapshot["id"]},
        )


def test_compare_scenarios_uses_latest_server_snapshots_and_rechecks_access(clients):
    scenario, revision, saved, _ = setup_revision(clients)
    first_revision_id = saved.json()["id"]
    second = mutation(
        clients["specialist"],
        "POST",
        f"/v1/scenarios/{scenario['id']}/revisions",
        {
            **revision,
            "parent_revision_id": first_revision_id,
            "comment": "SYNTHETIC TEST comparison revision",
        },
        etag=saved.headers["etag"],
    )
    assert second.status_code == 201, second.text
    second_revision_id = second.json()["id"]
    first_snapshot = mutation(
        clients["specialist"],
        "POST",
        "/v1/calculations/fast",
        {
            "scenario_revision_id": first_revision_id,
            "mode": "fast",
            "include_modules": ["cost"],
            "seed": 17,
        },
    )
    assert first_snapshot.status_code == 200, first_snapshot.text
    second_snapshot = mutation(
        clients["specialist"],
        "POST",
        "/v1/calculations/fast",
        {
            "scenario_revision_id": second_revision_id,
            "mode": "fast",
            "include_modules": ["cost", "survival"],
            "seed": 17,
        },
    )
    assert second_snapshot.status_code == 200, second_snapshot.text
    body = {"scenario_revision_ids": [first_revision_id, second_revision_id]}
    key = str(uuid4())
    compared = mutation(clients["specialist"], "POST", "/v1/comparisons", body, key=key)
    assert compared.status_code == 200, compared.text
    validate("CompareResult", compared.json())
    assert [item["id"] for item in compared.json()["snapshots"]] == [
        first_snapshot.json()["snapshot"]["id"],
        second_snapshot.json()["snapshot"]["id"],
    ]
    assert {item["code"] for item in compared.json()["comparability_warnings"]} >= {
        "comparison_snapshot_stale",
        "comparison_snapshot_partial",
    }
    assert (
        mutation(clients["specialist"], "POST", "/v1/comparisons", body, key=key).json()
        == compared.json()
    )
    duplicate = mutation(
        clients["specialist"],
        "POST",
        "/v1/comparisons",
        {"scenario_revision_ids": [first_revision_id, first_revision_id]},
    )
    assert duplicate.status_code == 422
    assert duplicate.json()["code"] == "scenario_comparison_invalid"
    missing = mutation(
        clients["specialist"],
        "POST",
        "/v1/comparisons",
        {"scenario_revision_ids": [scenario["current_revision_id"], second_revision_id]},
    )
    assert missing.status_code == 422
    assert missing.json()["code"] == "scenario_comparison_unavailable"
    assert {item["code"] for item in missing.json()["blockers"]} == {
        "comparison_calculation_missing"
    }
    assert mutation(clients["outsider"], "POST", "/v1/comparisons", body).status_code == 404


def test_approval_requires_eligible_complete_full_job_not_a_fast_or_partial_result(clients):
    scenario, _, saved, _ = setup_revision(clients)
    revision_id = saved.json()["id"]
    fast = mutation(
        clients["specialist"],
        "POST",
        "/v1/calculations/fast",
        {
            "scenario_revision_id": revision_id,
            "mode": "fast",
            "include_modules": ["cost"],
            "seed": 17,
        },
    )
    assert fast.status_code == 200, fast.text
    queued = mutation(
        clients["specialist"],
        "POST",
        "/v1/calculations",
        {
            "scenario_revision_id": revision_id,
            "mode": "full",
            "include_modules": ["cost", "survival", "care"],
            "seed": 17,
        },
    )
    assert queued.status_code == 202, queued.text
    run_job.run(queued.json()["id"])
    current = clients["specialist"].get(f"/v1/scenarios/{scenario['id']}")
    review = mutation(
        clients["specialist"],
        "POST",
        f"/v1/scenarios/{scenario['id']}/transitions",
        {
            "target_status": "in_review",
            "reason": "SYNTHETIC TEST review",
            "revision_id": revision_id,
        },
        etag=current.headers["etag"],
    )
    assert review.status_code == 200, review.text
    approved = mutation(
        clients["admin"],
        "POST",
        f"/v1/scenarios/{scenario['id']}/transitions",
        {
            "target_status": "approved",
            "reason": "SYNTHETIC TEST must remain blocked",
            "revision_id": revision_id,
        },
        etag=review.headers["etag"],
    )
    assert approved.status_code == 422, approved.text
    assert {item["code"] for item in approved.json()["blockers"]} >= {
        "safety_inputs_missing",
        "approval_synthetic_inputs",
        "approved_calculation_incomplete",
    }


def test_missing_rate_is_null_not_zero_and_unaccepted_modules_are_explicit(clients):
    _, _, saved, _ = setup_revision(clients, with_rate=False)
    response = mutation(
        clients["specialist"],
        "POST",
        "/v1/calculations/fast",
        {
            "scenario_revision_id": saved.json()["id"],
            "mode": "fast",
            "include_modules": ["cost", "survival", "care", "suitability"],
            "seed": 0,
        },
    )
    assert response.status_code == 200, response.text
    value = response.json()
    validate("FastCalculationResponse", value)
    snapshot = value["snapshot"]
    assert snapshot["status"] == "partial"
    assert snapshot["cost"]["known_subtotal"] == "0.00"
    assert snapshot["cost"]["total"] is None
    assert snapshot["cost"]["lines"][0]["unit_price"] is None
    assert snapshot["cost"]["lines"][0]["subtotal"] is None
    missing_rate = next(item for item in snapshot["cost"]["data_gaps"] if item["code"] == "missing_rate")
    assert missing_rate["message"].startswith("Нет применимой расценки:")
    assert snapshot["survival"][0]["points"][0]["probability"] is None
    assert snapshot["care"] == []
    warning_codes = {item["code"] for item in snapshot["warnings"]}
    assert {"model_version_unavailable", "care_rule_unavailable"} <= warning_codes
    warning_messages = {item["code"]: item["message"] for item in snapshot["warnings"]}
    assert warning_messages["model_version_unavailable"] == "Прогноз приживаемости недоступен"
    assert warning_messages["care_rule_unavailable"] == "Не выбран утверждённый график ухода"
    assert value["recommendations"][0]["score"] is None


def test_rate_bundle_adds_server_side_material_and_planting_lines(clients):
    scenario, revision, saved, material = setup_revision(clients)
    source_version = material["source_refs"][0]["dataset_version_id"]
    planting = create_rate(
        clients, source_version, category="planting_work", unit_price="5.00"
    )
    bundled = {
        **revision,
        "parent_revision_id": saved.json()["id"],
        "rate_version_ids": [material["version_id"], planting["version_id"]],
        "comment": "SYNTHETIC TEST exact rate bundle",
    }
    updated = mutation(
        clients["specialist"],
        "POST",
        f"/v1/scenarios/{scenario['id']}/revisions",
        bundled,
        etag=saved.headers["etag"],
    )
    assert updated.status_code == 201, updated.text
    assert updated.json()["rate_version_ids"] == [
        material["version_id"],
        planting["version_id"],
    ]
    calculated = mutation(
        clients["specialist"],
        "POST",
        "/v1/calculations/fast",
        {
            "scenario_revision_id": updated.json()["id"],
            "mode": "fast",
            "include_modules": ["cost"],
            "seed": 23,
        },
    )
    assert calculated.status_code == 200, calculated.text
    snapshot = calculated.json()["snapshot"]
    assert snapshot["cost"]["status"] == "incomplete"
    assert snapshot["cost"]["known_subtotal"] == "45.03"
    assert {line["category"] for line in snapshot["cost"]["lines"]} == {
        "material",
        "planting",
    }
    manifest = clients["specialist"].get(snapshot["manifest_url"]).json()
    assert manifest["rate_version_ids"] == [
        material["version_id"],
        planting["version_id"],
    ]


def test_expected_replacement_cohorts_and_risk_reserve_are_not_double_counted(clients):
    scenario, revision, saved, material = setup_revision(clients, with_model=True)
    source_version = material["source_refs"][0]["dataset_version_id"]
    planting = create_rate(
        clients, source_version, category="planting_work", unit_price="5.00"
    )
    reserve = create_rate(
        clients, source_version, category="risk_reserve", unit_price="1.00"
    )
    updated = mutation(
        clients["specialist"],
        "POST",
        f"/v1/scenarios/{scenario['id']}/revisions",
        {
            **revision,
            "parent_revision_id": saved.json()["id"],
            "rate_version_ids": [
                material["version_id"],
                planting["version_id"],
                reserve["version_id"],
            ],
            "comment": "SYNTHETIC TEST expected cohorts and reserve",
        },
        etag=saved.headers["etag"],
    )
    assert updated.status_code == 201, updated.text
    calculated = mutation(
        clients["specialist"],
        "POST",
        "/v1/calculations/fast",
        {
            "scenario_revision_id": updated.json()["id"],
            "mode": "fast",
            "include_modules": ["cost"],
            "seed": 29,
        },
    )
    assert calculated.status_code == 200, calculated.text
    cost = calculated.json()["snapshot"]["cost"]
    assert cost["status"] == "complete"
    assert cost["known_subtotal"] == "66.04"
    assert cost["total"] == "66.04"
    assert {line["category"] for line in cost["lines"]} == {
        "material",
        "planting",
        "replacement_expected",
        "risk_reserve",
    }
    replacement = [line for line in cost["lines"] if line["category"] == "replacement_expected"]
    assert len(replacement) == 6
    assert sorted({line["year"] for line in replacement}) == [1, 2, 3]
    assert sum(1 for line in cost["lines"] if line["category"] == "risk_reserve") == 1
    assert "S_0 - S_1" in replacement[0]["formula"]
    assert "charged once" in replacement[0]["formula"]


def test_expert_survival_model_is_frozen_and_calculated_without_local_claim(clients):
    _, _, saved, _ = setup_revision(clients, with_rate=False, with_model=True)
    response = mutation(
        clients["specialist"],
        "POST",
        "/v1/calculations/fast",
        {
            "scenario_revision_id": saved.json()["id"],
            "mode": "fast",
            "include_modules": ["survival"],
            "seed": 31,
        },
    )
    assert response.status_code == 200, response.text
    result = response.json()["snapshot"]["survival"][0]
    assert result["model_kind"] == "expert_rules"
    assert result["calibration_status"] == "expert_confirmed"
    assert [point["probability"] for point in result["points"]] == [0.8, 0.7, 0.6]
    assert result["data_gaps"] == []
    manifest = clients["specialist"].get(response.json()["snapshot"]["manifest_url"]).json()
    assert manifest["model_version_ids"] == [saved.json()["model_version_id"]]


def test_explicit_uncalibrated_estimate_calculates_a_draft_but_blocks_approval(clients):
    scenario, _, saved, _ = setup_revision(
        clients,
        with_rate=False,
        with_model=True,
        model_kwargs={
            "calibration_status": "uncalibrated",
            "expert_status": "pending",
        },
        rule_status="verified_text_requires_expert",
    )
    assert saved.json()["synthetic_inputs"] is True
    response = mutation(
        clients["specialist"],
        "POST",
        "/v1/calculations/fast",
        {
            "scenario_revision_id": saved.json()["id"],
            "mode": "fast",
            "include_modules": ["survival"],
            "seed": 37,
        },
    )
    assert response.status_code == 200, response.text
    snapshot = response.json()["snapshot"]
    assert snapshot["status"] == "complete"
    assert snapshot["synthetic_inputs"] is True
    assert {result["calibration_status"] for result in snapshot["survival"]} == {
        "uncalibrated"
    }
    assert all(
        point["probability"] is not None
        for result in snapshot["survival"]
        for point in result["points"]
    )

    current = clients["specialist"].get(f"/v1/scenarios/{scenario['id']}")
    review = mutation(
        clients["specialist"],
        "POST",
        f"/v1/scenarios/{scenario['id']}/transitions",
        {
            "target_status": "in_review",
            "reason": "SYNTHETIC TEST estimated draft review",
            "revision_id": saved.json()["id"],
        },
        etag=current.headers["etag"],
    )
    assert review.status_code == 200, review.text
    approved = mutation(
        clients["admin"],
        "POST",
        f"/v1/scenarios/{scenario['id']}/transitions",
        {
            "target_status": "approved",
            "reason": "SYNTHETIC TEST estimated inputs must stay blocked",
            "revision_id": saved.json()["id"],
        },
        etag=review.headers["etag"],
    )
    assert approved.status_code == 422, approved.text
    assert "approval_synthetic_inputs" in {
        item["code"] for item in approved.json()["blockers"]
    }


def test_custom_care_calendar_enforces_resources_and_adds_cost_line(clients):
    scenario, revision, saved, material = setup_revision(clients, with_model=True)
    source_version = material["source_refs"][0]["dataset_version_id"]
    care_rate = create_rate(clients, source_version, category="care", unit_price="2.00")
    reserve_rate = create_rate(
        clients, source_version, category="risk_reserve", unit_price="1.00"
    )
    rule = clients["viewer"].get(f"/v1/rule-versions/{RULE_ID}").json()
    operation = {
        "id": str(uuid4()),
        "placement_ids": [revision["placements"][0]["id"]],
        "month": 5,
        "year_offset": 0,
        "operation": "SYNTHETIC TEST watering visit",
        "quantity": 2,
        "unit": "piece",
        "water_m3": 1.0,
        "crew_minutes": 60,
        "visits": 1,
        "rate_version_id": care_rate["version_id"],
        "rule_version_id": RULE_ID,
    }
    base = {
        **revision,
        "parent_revision_id": saved.json()["id"],
        "dataset_version_ids": [
            *revision["dataset_version_ids"],
            rule["source"]["dataset_version_id"],
        ],
        "rate_version_ids": [
            material["version_id"],
            care_rate["version_id"],
            reserve_rate["version_id"],
        ],
        "care_strategy": "custom",
        "custom_care_operations": [operation],
        "comment": "SYNTHETIC TEST sourced care calendar",
    }
    exceeded = mutation(
        clients["specialist"],
        "POST",
        f"/v1/scenarios/{scenario['id']}/revisions",
        {
            **base,
            "resource_limits": [
                {
                    "period": "year:0",
                    "water_m3": 0.5,
                    "crew_minutes": 100,
                    "max_visits": 2,
                    "care_budget": None,
                }
            ],
        },
        etag=saved.headers["etag"],
    )
    assert exceeded.status_code == 422
    assert exceeded.json()["code"] == "care_resource_exceeded"
    assert exceeded.json()["detail"] == "План превышает лимит воды для 1-го года"
    assert exceeded.json()["field_errors"] == [
        {
            "path": "/resource_limits/0/water_m3",
            "code": "care_resource_exceeded",
            "message": "По плану 1 м³, доступно 0.5 м³.",
        }
    ]
    valid = mutation(
        clients["specialist"],
        "POST",
        f"/v1/scenarios/{scenario['id']}/revisions",
        {
            **base,
            "resource_limits": [
                {
                    "period": "year:0",
                    "water_m3": 1.0,
                    "crew_minutes": 60,
                    "max_visits": 1,
                    "care_budget": None,
                }
            ],
        },
        etag=saved.headers["etag"],
    )
    assert valid.status_code == 201, valid.text
    calculated = mutation(
        clients["specialist"],
        "POST",
        "/v1/calculations/fast",
        {
            "scenario_revision_id": valid.json()["id"],
            "mode": "fast",
            "include_modules": ["cost", "care"],
            "seed": 37,
        },
    )
    assert calculated.status_code == 200, calculated.text
    snapshot = calculated.json()["snapshot"]
    # Care for the frozen expected replacement cohort is priced separately from the
    # original cohort, so the authoritative subtotal includes both schedules.
    assert snapshot["cost"]["known_subtotal"] == "50.64"
    assert snapshot["cost"]["status"] == "complete"
    assert snapshot["cost"]["data_gaps"] == []
    assert [item["id"] for item in snapshot["care"]] == [operation["id"]]
    assert any(line["category"] == "care" for line in snapshot["cost"]["lines"])


def test_full_calculation_job_persists_request_recovers_result_and_replays(clients):
    _, _, saved, _ = setup_revision(clients)
    request = {
        "scenario_revision_id": saved.json()["id"],
        "mode": "full",
        "include_modules": ["cost", "ecosystem"],
        "seed": 41,
    }
    key = str(uuid4())
    queued = mutation(
        clients["specialist"], "POST", "/v1/calculations", request, key=key
    )
    assert queued.status_code == 202, queued.text
    replay = mutation(
        clients["specialist"], "POST", "/v1/calculations", request, key=key
    )
    assert replay.json() == queued.json()
    run_job.run(queued.json()["id"])
    job = clients["specialist"].get(f"/v1/jobs/{queued.json()['id']}")
    assert job.status_code == 200, job.text
    assert job.json()["state"] == "succeeded"
    snapshot = clients["specialist"].get(
        f"/v1/calculations/{job.json()['result_ref_id']}"
    )
    assert snapshot.status_code == 200, snapshot.text
    assert snapshot.json()["status"] == "partial"
    assert snapshot.json()["cost"]["known_subtotal"] == "30.03"
    assert "ecosystem_coefficient_unavailable" in {
        item["code"] for item in snapshot.json()["warnings"]
    }
    assert "Экологические показатели сохранены как недоступные до утверждения локальных коэффициентов" in {
        item["message"] for item in snapshot.json()["warnings"]
    }


def test_rate_source_is_canonical_and_list_is_authorized(clients):
    version_id = publish_rate_source(clients)
    rate = create_rate(clients, version_id)
    assert rate["source_refs"][0]["label"] != "CLIENT LABEL MUST BE REPLACED"
    page = clients["viewer"].get(f"/v1/rates?city_id={CITY_ID}")
    assert page.status_code == 200 and page.json()["items"] == [rate]
    replay_key = str(uuid4())
    body = {
        "city_id": CITY_ID,
        "category": "plant_material",
        "unit": "piece",
        "unit_price": "10.01",
        "currency": "KZT",
        "valid_from": "2026-01-01",
        "tax_mode": "included",
        "source_refs": [rate["source_refs"][0]],
        "valid_to": None,
        "price_observed_at": "2026-10-29",
        "checked_at": "2026-10-30",
        "applicability_status": "current",
        "included": "SYNTHETIC TEST material",
        "excluded": "labor",
    }
    first = mutation(clients["admin"], "POST", "/v1/rates", body, key=replay_key)
    second = mutation(clients["admin"], "POST", "/v1/rates", body, key=replay_key)
    assert first.status_code == 201 and second.json() == first.json()
