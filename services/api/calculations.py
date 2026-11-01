"""Source-backed rates and reproducible immutable fast-calculation snapshots."""

import math
from datetime import UTC, date, datetime
from decimal import ROUND_HALF_UP, Decimal
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy import select

from packages.domain.contracts import validate
from packages.domain.cost import calculate_cost
from packages.domain.errors import DomainError, gap
from services.api.config import settings
from services.api.models import (
    CalculationSnapshotRecord,
    CatalogVersion,
    Dataset,
    DatasetVersion,
    ImportRecord,
    Job,
    PlantVersion,
    RateIdentity,
    RateVersionRecord,
    RevisionDataset,
    RuleVersionRecord,
    Scenario,
    ScenarioRevision,
    StockItemRecord,
    SurvivalModelRecord,
    ZoneVersion,
)


def _source_ref(dataset, version, source_record_id):
    return {
        "dataset_version_id": version.id,
        "source_record_id": source_record_id,
        "label": dataset.payload["name"],
        "uri": dataset.payload["source_uri"],
    }


def _canonical_rate_sources(db, access, body):
    if not body["source_refs"]:
        raise DomainError(422, "rate_source_invalid", "Rate requires published source records")
    version_ids = {item["dataset_version_id"] for item in body["source_refs"]}
    if len(version_ids) != 1:
        raise DomainError(422, "rate_source_invalid", "One rate version uses one dataset version")
    version = db.get(DatasetVersion, next(iter(version_ids)))
    if not version or version.status != "published":
        raise DomainError(422, "rate_source_invalid", "Rate source is not published")
    dataset = db.get(Dataset, version.dataset_id)
    access.dataset(dataset)
    if dataset.city_id != body["city_id"] or dataset.payload["kind"] != "rates":
        raise DomainError(422, "rate_source_invalid", "Rate source must be a city rates dataset")
    canonical = []
    seen = set()
    for supplied in body["source_refs"]:
        source_record_id = supplied["source_record_id"]
        if source_record_id is None or source_record_id in seen:
            raise DomainError(422, "rate_source_invalid", "Rate source records must be unique")
        exists = db.scalar(
            select(ImportRecord.row_index).where(
                ImportRecord.version_id == version.id,
                ImportRecord.payload["source_record_id"].astext == source_record_id,
            )
        )
        if exists is None:
            raise DomainError(422, "rate_source_invalid", "Rate source record was not found")
        seen.add(source_record_id)
        canonical.append(_source_ref(dataset, version, source_record_id))
    return canonical, dataset, version


def create_rate_version(db, access, body, *, uid):
    access.city(body["city_id"])
    sources, dataset, version = _canonical_rate_sources(db, access, body)
    if body["applicability_status"] == "current":
        today = date.today().isoformat()
        if body["checked_at"] is None or body["price_observed_at"] is None:
            raise DomainError(
                422,
                "rate_source_invalid",
                "Current rate requires checked_at and price_observed_at",
            )
        if body["valid_from"] and body["valid_from"] > today:
            raise DomainError(422, "rate_source_invalid", "Current rate starts in the future")
        if body["valid_to"] and body["valid_to"] < today:
            raise DomainError(422, "rate_source_invalid", "Current rate has expired")
    rate_id, version_id = uid(), uid()
    payload = {"id": rate_id, "version_id": version_id, **body, "source_refs": sources}
    validate("Rate", payload)
    created_at = datetime.now(UTC)
    db.add(RateIdentity(id=rate_id))
    db.flush()
    db.add(
        RateVersionRecord(
            id=version_id,
            rate_id=rate_id,
            city_id=body["city_id"],
            dataset_id=dataset.id,
            dataset_version_id=version.id,
            actor_id=access.user.id,
            created_at=created_at,
            payload=payload,
        )
    )
    return payload


def authorize_rate(db, access, version_id, *, city_id=None):
    rate = db.get(RateVersionRecord, version_id)
    if rate is None:
        raise DomainError(404, "not_found", "Rate version was not found")
    access.dataset(db.get(Dataset, rate.dataset_id))
    if city_id is not None and rate.city_id != city_id:
        raise DomainError(422, "rate_version_unavailable", "Rate belongs to another city")
    return rate


def validate_revision_rates(db, access, scenario, version_ids):
    synthetic = False
    categories = set()
    for version_id in version_ids:
        rate = authorize_rate(db, access, version_id, city_id=scenario.city_id)
        key = (rate.payload["category"], rate.payload["unit"])
        if key in categories:
            raise DomainError(
                422,
                "rate_version_unavailable",
                "Rate bundle cannot contain duplicate category and unit",
            )
        categories.add(key)
        synthetic = synthetic or db.get(DatasetVersion, rate.dataset_version_id).synthetic
    return synthetic


def revision_rate_ids(revision):
    ids = list(revision.payload.get("rate_version_ids", []))
    legacy = revision.payload.get("rate_version_id")
    if legacy and legacy not in ids:
        ids.append(legacy)
    return ids


def validate_care_calendar(db, access, scenario, body, rate_ids):
    operations = body["custom_care_operations"]
    if body["care_strategy"] == "custom" and not operations:
        raise DomainError(422, "care_calendar_invalid", "Custom care strategy needs operations")
    if body["care_strategy"] != "custom" and operations:
        raise DomainError(422, "care_calendar_invalid", "Care operations require custom strategy")
    placement_ids = {item["id"] for item in body["placements"]}
    operation_ids = [item["id"] for item in operations]
    if len(operation_ids) != len(set(operation_ids)):
        raise DomainError(422, "care_calendar_invalid", "Care operation ids must be unique")
    version_ids = set(body["dataset_version_ids"])
    for operation in operations:
        selected = operation["placement_ids"]
        if not selected or len(selected) != len(set(selected)) or not set(selected) <= placement_ids:
            raise DomainError(
                422, "care_calendar_invalid", "Care operation placements are invalid"
            )
        if operation["year_offset"] >= body["care_horizon_years"]:
            raise DomainError(422, "care_calendar_invalid", "Care operation exceeds horizon")
        from services.api.catalog import usable_rule

        rule = usable_rule(db, access, operation["rule_version_id"], city_id=scenario.city_id)
        if rule.dataset_version_id not in version_ids:
            raise DomainError(
                422,
                "care_calendar_invalid",
                "Care rule dataset version must be frozen in the revision",
            )
        if operation["rate_version_id"]:
            if operation["rate_version_id"] not in rate_ids:
                raise DomainError(
                    422, "care_calendar_invalid", "Care rate must be in the frozen rate bundle"
                )
            rate = authorize_rate(
                db, access, operation["rate_version_id"], city_id=scenario.city_id
            )
            if rate.payload["unit"] != operation["unit"]:
                raise DomainError(422, "care_calendar_invalid", "Care rate unit mismatch")
    limits = {}
    for limit in body["resource_limits"]:
        period = limit["period"]
        if not period.startswith("year:"):
            raise DomainError(422, "care_calendar_invalid", "Care limit period must be year:N")
        try:
            year = int(period.split(":", 1)[1])
        except ValueError:
            raise DomainError(422, "care_calendar_invalid", "Care limit period is invalid") from None
        if year < 0 or year >= body["care_horizon_years"] or year in limits:
            raise DomainError(422, "care_calendar_invalid", "Care limit year is invalid")
        limits[year] = limit
    for year, limit in limits.items():
        selected = [item for item in operations if item["year_offset"] == year]
        totals = {
            "water_m3": sum(item["water_m3"] for item in selected),
            "crew_minutes": sum(item["crew_minutes"] for item in selected),
            "max_visits": sum(item["visits"] for item in selected),
        }
        for key, used in totals.items():
            if limit[key] is not None and used > limit[key]:
                raise DomainError(
                    422,
                    "care_resource_exceeded",
                    f"Care {key} exceeds year {year} limit",
                )


def _material_cost(db, revision, snapshot_id):
    catalog_id = revision.payload["catalog_version_id"]
    plants = {}
    if catalog_id:
        plants = {
            row.plant_id: row.payload
            for row in db.scalars(
                select(PlantVersion).where(PlantVersion.catalog_version_id == catalog_id)
            )
        }
    rates = [db.get(RateVersionRecord, rate_id) for rate_id in revision_rate_ids(revision)]
    material_rate = next(
        (
            rate
            for rate in rates
            if rate.payload["category"] == "plant_material"
            and rate.payload["unit"] == "piece"
            and rate.payload["applicability_status"] == "current"
        ),
        None,
    )
    reserve_rate = next(
        (
            rate
            for rate in rates
            if rate.payload["category"] == "risk_reserve"
            and rate.payload["unit"] == "piece"
            and rate.payload["applicability_status"] == "current"
        ),
        None,
    )
    initial_gaps = []
    for rate in rates:
        if rate.payload["applicability_status"] != "current":
            initial_gaps.append(gap("rate_not_applicable", "Выбранная расценка не является текущей", rate.id))
        if rate.payload["tax_mode"] in {"excluded", "unknown"}:
            initial_gaps.append(gap("tax_unresolved", "Налоговый режим расценки не определён", rate.id))
    lines = []
    material_lines = {}
    for placement in revision.payload["placements"]:
        plant = plants.get(placement["plant_id"])
        description = plant["russian_name"] if plant else "Plant material"
        stock = (
            db.get(StockItemRecord, placement["stock_item_id"])
            if placement["stock_item_id"]
            else None
        )
        price = stock.payload["unit_price"] if stock else None
        sources = stock.payload["source_refs"] if stock else []
        tax_mode = stock.payload["tax_mode"] if stock else "unknown"
        observed = (
            stock.payload["observed_at"][:10]
            if stock and stock.payload["observed_at"]
            else None
        )
        if stock is None and material_rate:
            price = material_rate.payload["unit_price"]
            sources = material_rate.payload["source_refs"]
            tax_mode = material_rate.payload["tax_mode"]
            observed = material_rate.payload["price_observed_at"]
        line = {
                "id": str(uuid5(NAMESPACE_URL, f"{snapshot_id}:material:{placement['id']}")),
                "category": "material",
                "description": description,
                "quantity": placement["quantity"],
                "unit": "piece",
                "unit_price": price,
                "subtotal": None,
                "year": 0,
                "rate_version_id": material_rate.id if material_rate and stock is None else None,
                "formula": "pending server calculation",
                "source_refs": sources,
                "tax_mode": tax_mode,
                "price_observed_at": observed,
                "rate_status": material_rate.payload["applicability_status"]
                if material_rate and stock is None
                else None,
            }
        lines.append(line)
        material_lines[placement["id"]] = line
        if stock and stock.payload["tax_mode"] in {"excluded", "unknown"}:
            initial_gaps.append(gap("tax_unresolved", "Налоговый режим складского предложения не определён", stock.id))
    care_rate_ids = set()
    for operation in revision.payload["custom_care_operations"]:
        care_rate = (
            db.get(RateVersionRecord, operation["rate_version_id"])
            if operation["rate_version_id"]
            else None
        )
        if care_rate:
            care_rate_ids.add(care_rate.id)
        lines.append(
            {
                "id": str(uuid5(NAMESPACE_URL, f"{snapshot_id}:care:{operation['id']}")),
                "category": "water"
                if care_rate and care_rate.payload["category"] == "water"
                else "care",
                "description": operation["operation"],
                "quantity": operation["quantity"],
                "unit": operation["unit"],
                "unit_price": care_rate.payload["unit_price"] if care_rate else None,
                "subtotal": None,
                "year": operation["year_offset"],
                "rate_version_id": care_rate.id if care_rate else None,
                "formula": "pending server calculation",
                "source_refs": care_rate.payload["source_refs"] if care_rate else [],
                "tax_mode": care_rate.payload["tax_mode"] if care_rate else "unknown",
                "price_observed_at": care_rate.payload["price_observed_at"]
                if care_rate
                else None,
                "rate_status": care_rate.payload["applicability_status"]
                if care_rate
                else None,
            }
        )
    total_pieces = sum(item["quantity"] for item in revision.payload["placements"])
    categories = {
        "planting_work": "planting",
        "delivery": "delivery",
        "site_preparation": "preparation",
    }
    for rate in rates:
        category = categories.get(rate.payload["category"])
        if (
            rate is material_rate
            or rate.payload["category"] == "plant_material"
            or rate.id in care_rate_ids
            or rate is reserve_rate
        ):
            continue
        if (
            category
            and rate.payload["unit"] == "piece"
            and rate.payload["applicability_status"] == "current"
        ):
            lines.append(
                {
                    "id": str(uuid5(NAMESPACE_URL, f"{snapshot_id}:rate:{rate.id}")),
                    "category": category,
                    "description": rate.payload["category"],
                    "quantity": total_pieces,
                    "unit": "piece",
                    "unit_price": rate.payload["unit_price"],
                    "subtotal": None,
                    "year": 0,
                    "rate_version_id": rate.id,
                    "formula": "pending server calculation",
                    "source_refs": rate.payload["source_refs"],
                    "tax_mode": rate.payload["tax_mode"],
                    "price_observed_at": rate.payload["price_observed_at"],
                    "rate_status": rate.payload["applicability_status"],
                }
            )
        else:
            initial_gaps.append(
                gap(
                    "rate_quantity_basis_missing",
                    "Для выбранной расценки в этой версии нет однозначной базы количества",
                    rate.id,
                )
            )
    if revision.payload["placements"]:
        if reserve_rate:
            lines.append(
                {
                    "id": str(uuid5(NAMESPACE_URL, f"{snapshot_id}:risk-reserve")),
                    "category": "risk_reserve",
                    "description": "Risk reserve per initial planted piece",
                    "quantity": total_pieces,
                    "unit": "piece",
                    "unit_price": reserve_rate.payload["unit_price"],
                    "subtotal": None,
                    "year": 0,
                    "rate_version_id": reserve_rate.id,
                    "formula": "initial planted quantity; reserve is separate from expected replacements",
                    "source_refs": reserve_rate.payload["source_refs"],
                    "tax_mode": reserve_rate.payload["tax_mode"],
                    "price_observed_at": reserve_rate.payload["price_observed_at"],
                    "rate_status": reserve_rate.payload["applicability_status"],
                }
            )
        else:
            initial_gaps.append(
                gap(
                    "risk_reserve_rate_missing",
                    "Не выбрана зафиксированная поштучная ставка резерва риска",
                    "risk_reserve",
                )
            )

        model = (
            db.get(SurvivalModelRecord, revision.payload["model_version_id"])
            if revision.payload["model_version_id"]
            else None
        )
        if model is None:
            initial_gaps.append(
                gap(
                    "replacement_model_missing",
                    "Для ожидаемых замен нужна зафиксированная модель приживаемости",
                    "model_version_id",
                )
            )
        else:
            component_rates = {
                rate.payload["category"]: rate
                for rate in rates
                if rate.payload["category"] in {"planting_work", "delivery"}
                and rate.payload["unit"] == "piece"
                and rate.payload["applicability_status"] == "current"
            }
            placement_quantities = {
                placement["id"]: Decimal(placement["quantity"])
                for placement in revision.payload["placements"]
            }
            care_basis = {
                operation["id"]: sum(
                    (placement_quantities[placement_id] for placement_id in operation["placement_ids"]),
                    Decimal(0),
                )
                for operation in revision.payload["custom_care_operations"]
            }
            replacement_resource_usage = {}
            for placement in revision.payload["placements"]:
                previous = Decimal(1)
                material = material_lines[placement["id"]]
                components = [("plant_material", material)] + [
                    (category, rate.payload)
                    for category, rate in sorted(component_rates.items())
                ]
                for point in sorted(model.payload["points"], key=lambda item: item["year"]):
                    survival = Decimal(str(point["probability"]))
                    expected = (
                        Decimal(placement["quantity"]) * (previous - survival)
                    ).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)
                    previous = survival
                    if expected == 0:
                        continue
                    for component, source in components:
                        if component == "plant_material":
                            rate_id = source["rate_version_id"]
                            price = source["unit_price"]
                            refs = source["source_refs"]
                            tax_mode = source["tax_mode"]
                            observed = source["price_observed_at"]
                            rate_status = source["rate_status"]
                        else:
                            rate = component_rates[component]
                            rate_id = rate.id
                            price = source["unit_price"]
                            refs = source["source_refs"]
                            tax_mode = source["tax_mode"]
                            observed = source["price_observed_at"]
                            rate_status = source["applicability_status"]
                        lines.append(
                            {
                                "id": str(
                                    uuid5(
                                        NAMESPACE_URL,
                                        f"{snapshot_id}:replacement:{placement['id']}:{point['year']}:{component}",
                                    )
                                ),
                                "category": "replacement_expected",
                                "description": f"Expected replacement {component}",
                                "quantity": float(expected),
                                "unit": "piece",
                                "unit_price": price,
                                "subtotal": None,
                                "year": point["year"],
                                "rate_version_id": rate_id,
                                "formula": (
                                    f"initial quantity * (S_{point['year'] - 1} - S_{point['year']}); "
                                    "initial cohort deaths charged once in death year"
                                ),
                                "source_refs": refs,
                                "tax_mode": tax_mode,
                                "price_observed_at": observed,
                                "rate_status": rate_status,
                            }
                        )
                    for operation in revision.payload["custom_care_operations"]:
                        if placement["id"] not in operation["placement_ids"]:
                            continue
                        basis = care_basis[operation["id"]]
                        if basis <= 0:
                            continue
                        scale = expected / basis
                        quantity = (Decimal(str(operation["quantity"])) * scale).quantize(
                            Decimal("0.000001"), rounding=ROUND_HALF_UP
                        )
                        if quantity == 0:
                            continue
                        care_rate = (
                            db.get(RateVersionRecord, operation["rate_version_id"])
                            if operation["rate_version_id"]
                            else None
                        )
                        shifted_year = point["year"] + operation["year_offset"]
                        lines.append(
                            {
                                "id": str(
                                    uuid5(
                                        NAMESPACE_URL,
                                        f"{snapshot_id}:replacement-care:{placement['id']}:{point['year']}:{operation['id']}",
                                    )
                                ),
                                "category": "replacement_expected",
                                "description": f"Expected replacement care: {operation['operation']}",
                                "quantity": float(quantity),
                                "unit": operation["unit"],
                                "unit_price": care_rate.payload["unit_price"]
                                if care_rate
                                else None,
                                "subtotal": None,
                                "year": shifted_year,
                                "rate_version_id": care_rate.id if care_rate else None,
                                "formula": (
                                    "care quantity * expected replacement cohort / initial quantity "
                                    "of the care operation placements; care schedule shifted from "
                                    f"year {operation['year_offset']} to year {shifted_year}"
                                ),
                                "source_refs": care_rate.payload["source_refs"]
                                if care_rate
                                else [],
                                "tax_mode": care_rate.payload["tax_mode"]
                                if care_rate
                                else "unknown",
                                "price_observed_at": care_rate.payload["price_observed_at"]
                                if care_rate
                                else None,
                                "rate_status": care_rate.payload["applicability_status"]
                                if care_rate
                                else None,
                            }
                        )
                        usage = replacement_resource_usage.setdefault(
                            shifted_year,
                            {"water_m3": Decimal(0), "crew_minutes": Decimal(0), "max_visits": Decimal(0)},
                        )
                        usage["water_m3"] += Decimal(str(operation["water_m3"])) * scale
                        usage["crew_minutes"] += Decimal(operation["crew_minutes"]) * scale
                        usage["max_visits"] += Decimal(operation["visits"]) * scale
            base_resource_usage = {}
            for operation in revision.payload["custom_care_operations"]:
                usage = base_resource_usage.setdefault(
                    operation["year_offset"],
                    {"water_m3": Decimal(0), "crew_minutes": Decimal(0), "max_visits": Decimal(0)},
                )
                usage["water_m3"] += Decimal(str(operation["water_m3"]))
                usage["crew_minutes"] += Decimal(operation["crew_minutes"])
                usage["max_visits"] += Decimal(operation["visits"])
            for limit in revision.payload["resource_limits"]:
                year = int(limit["period"].split(":", 1)[1])
                original = base_resource_usage.get(year, {})
                replacement = replacement_resource_usage.get(year, {})
                for field in ("water_m3", "crew_minutes", "max_visits"):
                    ceiling = limit[field]
                    used = original.get(field, Decimal(0)) + replacement.get(field, Decimal(0))
                    if ceiling is not None and used > Decimal(str(ceiling)):
                        initial_gaps.append(
                            gap(
                                "replacement_care_resource_exceeded",
                                f"Ожидаемый уход за заменами превышает лимит {field} в году {year}",
                                limit["period"],
                            )
                        )
    return calculate_cost(lines, initial_gaps)


def _missing_cost():
    reason = gap("calculation_module_unavailable", "Модуль стоимости не был запрошен", "cost")
    reason["blocking"] = False
    return {
        "currency": "KZT",
        "status": "incomplete",
        "known_subtotal": "0.00",
        "total": None,
        "lines": [],
        "data_gaps": [reason],
    }


def _survival(db, revision):
    model = (
        db.get(SurvivalModelRecord, revision.payload["model_version_id"])
        if revision.payload["model_version_id"]
        else None
    )
    risks = _survival_guidance(db, model) if model else []
    results = []
    for placement in revision.payload["placements"]:
        if model:
            results.append(
                {
                    "placement_id": placement["id"],
                    "model_kind": model.payload["model_kind"],
                    "calibration_status": model.payload["calibration_status"],
                    "points": model.payload["points"],
                    "risks": risks,
                    "data_gaps": [],
                }
            )
            continue
        results.append(
            {
                "placement_id": placement["id"],
                "model_kind": "expert_rules",
                "calibration_status": "uncalibrated",
                "points": [
                    {"year": year, "probability": None, "lower": None, "upper": None}
                    for year in (1, 2, 3)
                ],
                "risks": [],
                "data_gaps": [
                    gap(
                        "model_version_unavailable",
                        "Не выбрана утверждённая модель приживаемости",
                        "DR-04",
                    )
                ],
            }
        )
    return results


def _survival_guidance(db, model):
    """Read explanatory factors from the exact immutable records behind the model."""
    refs = {
        ref["source_record_id"]: ref
        for ref in model.payload.get("source_refs", [])
        if ref.get("dataset_version_id") == model.dataset_version_id
        and ref.get("source_record_id")
    }
    if not refs:
        return []
    records = db.scalars(
        select(ImportRecord).where(
            ImportRecord.version_id == model.dataset_version_id,
            ImportRecord.payload["source_record_id"].astext.in_(refs),
        )
    ).all()
    contributions = []
    for record in records:
        source_record_id = record.payload.get("source_record_id")
        source_ref = refs.get(source_record_id)
        properties = record.payload.get("properties", {})
        guidance = properties.get("survival_guidance")
        if source_ref is None or not isinstance(guidance, list):
            continue
        for item in guidance:
            if not isinstance(item, dict):
                continue
            kind = item.get("kind")
            factor = item.get("factor")
            explanation = item.get("explanation")
            try:
                score = None if item.get("score") is None else float(item["score"])
                weight = float(item.get("weight", 0))
            except (TypeError, ValueError):
                continue
            if (
                kind not in {"risk", "measure"}
                or not isinstance(factor, str)
                or not factor.strip()
                or not isinstance(explanation, str)
                or not explanation.strip()
                or score is not None
                and (not math.isfinite(score) or not 0 <= score <= 1)
                or not math.isfinite(weight)
                or weight < 0
            ):
                continue
            contributions.append(
                {
                    "factor": f"{kind}:{factor.strip()}",
                    "score": score,
                    "weight": weight,
                    "explanation": explanation.strip(),
                    "source_refs": [source_ref],
                }
            )
    return contributions


def _recommendations(db, revision):
    from services.api.catalog import intrinsic_eligibility

    catalog_id = revision.payload["catalog_version_id"]
    if not catalog_id:
        return []
    plants = {
        row.plant_id: row.payload
        for row in db.scalars(
            select(PlantVersion).where(PlantVersion.catalog_version_id == catalog_id)
        )
    }
    purpose = db.get(ZoneVersion, revision.zone_version_id).payload["purpose"]
    seen, results = set(), []
    for placement in revision.payload["placements"]:
        if placement["plant_id"] in seen or placement["plant_id"] not in plants:
            continue
        seen.add(placement["plant_id"])
        plant = plants[placement["plant_id"]]
        eligibility, blockers = intrinsic_eligibility(plant, purpose)
        blockers.append(
            gap(
                "suitability_weights_missing",
                "В сохранённой версии нет зафиксированных весов оценки",
                revision.id,
            )
        )
        if eligibility == "eligible":
            eligibility = "requires_review"
        results.append(
            {
                "plant_id": plant["id"],
                "eligibility": eligibility,
                "score": None,
                "data_coverage": 0,
                "contributions": [],
                "blockers": blockers,
            }
        )
    return results


def _manifest_sources(db, revision):
    sources = {}
    for version_id in db.scalars(
        select(RevisionDataset.version_id).where(RevisionDataset.revision_id == revision.id)
    ):
        version = db.get(DatasetVersion, version_id)
        dataset = db.get(Dataset, version.dataset_id)
        item = _source_ref(dataset, version, None)
        sources[(item["dataset_version_id"], None)] = item
    if revision.payload["catalog_version_id"]:
        for row in db.scalars(
            select(PlantVersion).where(
                PlantVersion.catalog_version_id == revision.payload["catalog_version_id"]
            )
        ):
            for trait in row.payload["traits"]:
                for item in trait["source_refs"]:
                    sources[(item["dataset_version_id"], item["source_record_id"])] = item
    if revision.payload["rule_version_id"]:
        rule = db.get(RuleVersionRecord, revision.payload["rule_version_id"])
        sources[(rule.payload["source"]["dataset_version_id"], rule.payload["source"]["source_record_id"])] = rule.payload["source"]
    for rate_id in revision_rate_ids(revision):
        rate = db.get(RateVersionRecord, rate_id)
        for item in rate.payload["source_refs"]:
            sources[(item["dataset_version_id"], item["source_record_id"])] = item
    if revision.payload["model_version_id"]:
        model = db.get(SurvivalModelRecord, revision.payload["model_version_id"])
        for item in model.payload["source_refs"]:
            sources[(item["dataset_version_id"], item["source_record_id"])] = item
    for placement in revision.payload["placements"]:
        if placement["stock_item_id"]:
            stock = db.get(StockItemRecord, placement["stock_item_id"])
            for item in stock.payload["source_refs"]:
                sources[(item["dataset_version_id"], item["source_record_id"])] = item
    return sorted(
        sources.values(),
        key=lambda item: (item["dataset_version_id"], item["source_record_id"] or ""),
    )


def _input_registry(db, revision):
    dataset_versions = [
        db.get(DatasetVersion, version_id).payload
        for version_id in db.scalars(
            select(RevisionDataset.version_id)
            .where(RevisionDataset.revision_id == revision.id)
            .order_by(RevisionDataset.version_id)
        )
    ]
    selected_plant_ids = sorted(
        {item["plant_id"] for item in revision.payload["placements"]}
        | {item["plant_id"] for item in revision.payload["area_patches"]}
    )
    catalog = None
    if revision.payload["catalog_version_id"]:
        version = db.get(CatalogVersion, revision.payload["catalog_version_id"])
        plants = list(
            db.scalars(
                select(PlantVersion)
                .where(
                    PlantVersion.catalog_version_id == revision.payload["catalog_version_id"],
                    PlantVersion.plant_id.in_(selected_plant_ids),
                )
                .order_by(PlantVersion.plant_id)
            )
        )
        catalog = {"manifest": version.payload, "plants": [row.payload for row in plants]}
    rule = (
        db.get(RuleVersionRecord, revision.payload["rule_version_id"]).payload
        if revision.payload["rule_version_id"]
        else None
    )
    rates = [db.get(RateVersionRecord, rate_id).payload for rate_id in revision_rate_ids(revision)]
    stock_items = [
        db.get(StockItemRecord, stock_id).payload
        for stock_id in sorted(
            {
                item["stock_item_id"]
                for item in revision.payload["placements"]
                if item["stock_item_id"]
            }
        )
    ]
    model = (
        db.get(SurvivalModelRecord, revision.payload["model_version_id"]).payload
        if revision.payload["model_version_id"]
        else None
    )
    return {
        "zone": db.get(ZoneVersion, revision.zone_version_id).payload,
        "dataset_versions": dataset_versions,
        "catalog": catalog,
        "rule": rule,
        "rate": rates[0] if rates else None,
        "rates": rates,
        "stock_items": stock_items,
        "model": model,
    }


def _ecosystem_metrics(db, revision):
    from services.api.ecosystem import ecosystem_metrics

    return ecosystem_metrics(db, revision)


def calculate_fast(db, access, body, *, uid, canonical_hash, now):
    from services.api.use_cases import audit, authorized_revision

    revision = authorized_revision(db, access, body["scenario_revision_id"])
    modules = body["include_modules"]
    if len(modules) != len(set(modules)):
        raise DomainError(422, "calculation_request_invalid", "Calculation modules are duplicated")
    scenario = db.get(Scenario, revision.scenario_id)
    for rate_id in revision_rate_ids(revision):
        authorize_rate(db, access, rate_id, city_id=scenario.city_id)
    snapshot_id = uid()
    cost = _material_cost(db, revision, snapshot_id) if "cost" in modules else _missing_cost()
    warnings = []
    unsupported_modules = [module for module in body["include_modules"] if module == "shadow"]
    for module in unsupported_modules:
        warnings.append(
            gap(
                "calculation_module_unavailable",
                f"Расчётный модуль «{module}» недоступен",
                module,
            )
        )
    survival = _survival(db, revision) if "survival" in modules else []
    if "survival" in modules and any(item["data_gaps"] for item in survival):
        warnings.append(gap("model_version_unavailable", "Прогноз приживаемости недоступен", "DR-04"))
    care = revision.payload["custom_care_operations"] if "care" in modules else []
    if "care" in modules and not care:
        warnings.append(gap("care_rule_unavailable", "Не выбран утверждённый график ухода", "DR-03"))
    recommendations = _recommendations(db, revision) if "suitability" in modules else []
    if "suitability" in modules:
        warnings.append(
            gap(
                "suitability_weights_missing",
                "В этой версии нет зафиксированных весов пригодности",
                revision.id,
            )
        )
    ecosystem = _ecosystem_metrics(db, revision) if "ecosystem" in modules else []
    if ecosystem and any(metric["status"] == "unavailable" for metric in ecosystem):
        warnings.append(
            gap(
                "ecosystem_coefficient_unavailable",
                "Экологические показатели сохранены как недоступные до утверждения локальных коэффициентов",
                "coefficient_version_id",
                "DR-06",
            )
        )
    input_value = {
        "request": body,
        "revision": revision.payload,
        "registry": _input_registry(db, revision),
        "sources": _manifest_sources(db, revision),
        "code_revision": settings().release,
    }
    input_hash = canonical_hash(input_value)
    created_at = now()
    requested_partial = (
        ("cost" in modules and cost["status"] != "complete")
        or ("survival" in modules and bool(warnings))
        or ("care" in modules and not care)
        or ("ecosystem" in modules and any(metric["status"] == "unavailable" for metric in ecosystem))
        or ("suitability" in modules and bool(recommendations or warnings))
        or bool(unsupported_modules)
    )
    snapshot = {
        "id": snapshot_id,
        "scenario_revision_id": revision.id,
        "input_hash": input_hash,
        "created_at": created_at,
        "status": "partial" if requested_partial else "complete",
        "is_stale": False,
        "synthetic_inputs": revision.payload["synthetic_inputs"],
        "cost": cost,
        "survival": survival,
        "care": care,
        "ecosystem": ecosystem,
        "warnings": warnings,
        "manifest_url": f"/v1/calculations/{snapshot_id}/manifest",
    }
    validate("CalculationSnapshot", snapshot)
    manifest = {
        "id": snapshot_id,
        "source_refs": input_value["sources"],
        "code_revision": settings().release,
        "model_version_ids": [revision.payload["model_version_id"]]
        if revision.payload["model_version_id"]
        else [],
        "coefficient_version_ids": [revision.payload["coefficient_version_id"]]
        if revision.payload["coefficient_version_id"]
        else [],
        "rate_version_ids": revision_rate_ids(revision),
        "seed": body["seed"],
        "input_hash": input_hash,
        "output_hash": canonical_hash(snapshot),
    }
    validate("SourceManifest", manifest)
    db.add(
        CalculationSnapshotRecord(
            id=snapshot_id,
            scenario_revision_id=revision.id,
            actor_id=access.user.id,
            input_hash=input_hash,
            created_at=datetime.fromisoformat(created_at),
            payload=snapshot,
            manifest=manifest,
        )
    )
    audit(db, access, "calculation.fast_created", snapshot_id, "CalculationSnapshot")
    return {"snapshot": snapshot, "recommendations": recommendations}


def persist_full_calculation(db, job):
    from services.api.models import Principal
    from services.api.security import Access
    from services.api.use_cases import canonical_hash, now, uid

    if not job.request_payload:
        raise DomainError(500, "job_input_invalid", "Calculation request is missing")
    user = db.get(Principal, job.owner_id)
    result = calculate_fast(
        db,
        Access(db, user, None),
        job.request_payload,
        uid=uid,
        canonical_hash=canonical_hash,
        now=now,
    )
    return result["snapshot"]["id"]


def authorized_snapshot(db, access, snapshot_id):
    from services.api.use_cases import authorized_revision, found

    snapshot = found(db.get(CalculationSnapshotRecord, snapshot_id))
    authorized_revision(db, access, snapshot.scenario_revision_id)
    return snapshot


def snapshot_payload(db, access, snapshot_id):
    snapshot = authorized_snapshot(db, access, snapshot_id)
    revision = db.get(ScenarioRevision, snapshot.scenario_revision_id)
    scenario = db.get(Scenario, revision.scenario_id)
    return {**snapshot.payload, "is_stale": scenario.current_revision_id != revision.id}


def list_snapshots(db, access, params, operation):
    """Snapshots bound to exactly this revision, after the same checks as getCalculation."""
    from services.api.use_cases import authorized_revision, page

    revision = authorized_revision(db, access, params["scenario_revision_id"])
    scenario = db.get(Scenario, revision.scenario_id)
    stale = scenario.current_revision_id != revision.id
    return page(
        db,
        CalculationSnapshotRecord,
        select(CalculationSnapshotRecord).where(
            CalculationSnapshotRecord.scenario_revision_id == revision.id
        ),
        params,
        operation,
        access,
        serialize=lambda snapshot: {**snapshot.payload, "is_stale": stale},
    )


def _comparison_warning(code, message, *inputs):
    return {
        "code": code,
        "message": message,
        "required_inputs": list(inputs),
        "blocking": False,
    }


def compare_scenarios(db, access, body):
    from services.api.use_cases import authorized_revision

    revision_ids = body["scenario_revision_ids"]
    if len(revision_ids) != len(set(revision_ids)):
        raise DomainError(
            422,
            "scenario_comparison_invalid",
            "Each scenario revision may appear only once",
        )
    revisions = [authorized_revision(db, access, revision_id) for revision_id in revision_ids]
    records = []
    blockers = []
    for revision in revisions:
        record = db.scalar(
            select(CalculationSnapshotRecord)
            .where(CalculationSnapshotRecord.scenario_revision_id == revision.id)
            .order_by(CalculationSnapshotRecord.created_at.desc(), CalculationSnapshotRecord.id.desc())
            .limit(1)
        )
        if record is None:
            blockers.append(
                gap(
                    "comparison_calculation_missing",
                    "Для версии сценария нет снимка расчёта",
                    revision.id,
                )
            )
        else:
            records.append(record)
    if blockers:
        raise DomainError(
            422,
            "scenario_comparison_unavailable",
            "Calculate every selected revision before comparison",
            blockers=blockers,
        )

    snapshots = []
    warnings = []
    for revision, record in zip(revisions, records, strict=True):
        scenario = db.get(Scenario, revision.scenario_id)
        snapshot = {**record.payload, "is_stale": scenario.current_revision_id != revision.id}
        snapshots.append(snapshot)
        if snapshot["status"] == "partial":
            warnings.append(
                _comparison_warning(
                    "comparison_snapshot_partial",
                    "A compared calculation is partial",
                    snapshot["id"],
                )
            )
        if snapshot["is_stale"]:
            warnings.append(
                _comparison_warning(
                    "comparison_snapshot_stale",
                    "A compared revision is not the current scenario revision",
                    revision.id,
                )
            )

    if len({revision.zone_version_id for revision in revisions}) > 1:
        warnings.append(
            _comparison_warning(
                "comparison_zone_versions_differ",
                "Compared revisions use different zone geometry versions",
                *[revision.zone_version_id for revision in revisions],
            )
        )
    registry_signatures = {
        (
            tuple(record.manifest["model_version_ids"]),
            tuple(record.manifest["coefficient_version_ids"]),
            tuple(record.manifest["rate_version_ids"]),
            record.manifest["code_revision"],
        )
        for record in records
    }
    if len(registry_signatures) > 1:
        warnings.append(
            _comparison_warning(
                "comparison_input_versions_differ",
                "Compared calculations use different registry or code versions",
                *[record.id for record in records],
            )
        )
    if len({snapshot["synthetic_inputs"] for snapshot in snapshots}) > 1:
        warnings.append(
            _comparison_warning(
                "comparison_input_profiles_differ",
                "Synthetic and admitted input profiles are mixed",
                *[snapshot["id"] for snapshot in snapshots],
            )
        )
    result = {"snapshots": snapshots, "comparability_warnings": warnings}
    validate("CompareResult", result)
    return result


def approval_calculation_blockers(db, revision):
    required_modules = {"cost", "survival", "care"}
    jobs = list(
        db.scalars(
            select(Job).where(
                Job.input_revision_id == revision.id,
                Job.input_kind == "revision",
                Job.state == "succeeded",
            )
        )
    )
    jobs.sort(key=lambda job: (job.payload["created_at"], job.id), reverse=True)
    full_jobs = [
        job
        for job in jobs
        if job.request_payload
        and job.request_payload.get("mode") == "full"
        and job.payload.get("kind") == "calculate"
    ]
    if not full_jobs:
        return [
            gap(
                "approved_calculation_missing",
                "Требуется сохранённый полный расчёт",
                "cost",
                "survival",
                "care",
            )
        ]
    eligible = [
        job
        for job in full_jobs
        if required_modules.issubset(set(job.request_payload.get("include_modules", [])))
    ]
    if not eligible:
        return [
            gap(
                "approved_calculation_modules_missing",
                "Полный расчёт должен включать стоимость, приживаемость и уход",
                "cost",
                "survival",
                "care",
            )
        ]
    for job in eligible:
        snapshot = db.get(CalculationSnapshotRecord, job.payload.get("result_ref_id"))
        if (
            snapshot
            and snapshot.scenario_revision_id == revision.id
            and snapshot.payload["status"] == "complete"
            and snapshot.payload["cost"]["status"] == "complete"
            and not any(item["blocking"] for item in snapshot.payload["warnings"])
        ):
            return []
    return [
        gap(
            "approved_calculation_incomplete",
            "Последний подходящий полный расчёт частичный или содержит блокирующие предупреждения",
            *[job.payload["result_ref_id"] for job in eligible if job.payload.get("result_ref_id")],
        )
    ]
