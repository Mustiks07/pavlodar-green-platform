"""Immutable plant catalog snapshots, source-backed rules and deterministic recommendations."""

from datetime import UTC, datetime
from uuid import NAMESPACE_URL, UUID, uuid5

from jsonschema import ValidationError
from shapely.geometry import Point, shape
from shapely.ops import transform
from sqlalchemy import func, select

from packages.domain.contracts import validate
from packages.domain.errors import DomainError
from packages.geo.geometry import PROJECT
from services.api.models import (
    CatalogState,
    CatalogVersion,
    Dataset,
    DatasetVersion,
    ImportRecord,
    PlantIdentity,
    PlantVersion,
    RuleVersionRecord,
    StockItemRecord,
    SurvivalModelRecord,
)

SENSITIVE_PURPOSES = {"school", "hospital"}


def data_gap(code, message, *inputs, blocking=True):
    return {
        "code": code,
        "message": message,
        "required_inputs": list(inputs),
        "blocking": blocking,
    }


def _canonical_source_ref(db, value):
    version = db.get(DatasetVersion, value["dataset_version_id"])
    if not version or version.status != "published":
        raise DomainError(422, "plant_reference_invalid", "Trait source is not published")
    dataset = db.get(Dataset, version.dataset_id)
    if dataset.access_level != "public":
        raise DomainError(
            422,
            "plant_reference_invalid",
            "Global catalog traits may reference only public datasets",
        )
    source_record_id = value["source_record_id"]
    if source_record_id is not None:
        exists = db.scalar(
            select(ImportRecord.row_index).where(
                ImportRecord.version_id == version.id,
                ImportRecord.payload["source_record_id"].astext == source_record_id,
            )
        )
        if exists is None:
            raise DomainError(422, "plant_reference_invalid", "Trait source record was not found")
    return (
        {
            "dataset_version_id": version.id,
            "source_record_id": source_record_id,
            "label": dataset.payload["name"],
            "uri": dataset.payload["source_uri"],
        },
        dataset,
        version,
    )


def canonicalize_plant_input(db, body):
    traits = []
    keys = set()
    source_datasets = []
    source_versions = []
    for trait in body["traits"]:
        key = trait["key"].strip()
        if not key or key in keys:
            raise DomainError(422, "plant_input_invalid", "Trait keys must be unique")
        keys.add(key)
        text_value, number_value = trait["value_text"], trait["value_number"]
        if trait["status"] == "unknown":
            if text_value is not None or number_value is not None:
                raise DomainError(422, "plant_input_invalid", "Unknown trait cannot have a value")
        elif (text_value is None) == (number_value is None):
            raise DomainError(
                422, "plant_input_invalid", "Known trait needs exactly one text or numeric value"
            )
        if number_value is not None and trait["unit"] is None:
            raise DomainError(422, "plant_input_invalid", "Numeric trait requires a unit")
        if text_value is not None and trait["unit"] is not None:
            raise DomainError(422, "plant_input_invalid", "Text trait cannot have a numeric unit")
        refs = []
        for source in trait["source_refs"]:
            canonical, dataset, version = _canonical_source_ref(db, source)
            refs.append(canonical)
            source_datasets.append(dataset)
            source_versions.append(version)
        if trait["status"] == "known" and not refs:
            raise DomainError(422, "plant_reference_invalid", "Known trait requires provenance")
        traits.append({**trait, "key": key, "source_refs": refs})

    if not traits or not any(dataset.payload["kind"] == "catalog" for dataset in source_datasets):
        raise DomainError(
            422,
            "catalog_source_required",
            "Plant needs at least one trait sourced from a published catalog dataset",
        )
    if body["sensitive_site_status"] == "excluded":
        if body["exclusion_reason"] is None or body["exclusion_basis"] is None:
            raise DomainError(
                422,
                "plant_input_invalid",
                "Sensitive-site exclusion requires a reason and basis",
            )
    elif body["exclusion_reason"] is not None or body["exclusion_basis"] is not None:
        raise DomainError(
            422,
            "plant_input_invalid",
            "Non-excluded plant cannot carry an exclusion reason or basis",
        )
    if (body["taxon_rank"] == "cultivar") != (body["cultivar"] is not None):
        raise DomainError(
            422, "plant_input_invalid", "Cultivar value and cultivar taxon rank must agree"
        )
    normalized = {
        **body,
        "latin_name": " ".join(body["latin_name"].split()),
        "russian_name": " ".join(body["russian_name"].split()),
        "traits": traits,
    }
    synthetic = any(version.synthetic for version in source_versions) or any(
        "SYNTHETIC" in dataset.payload["name"].upper() for dataset in source_datasets
    )
    return normalized, synthetic


def current_catalog_id(db, *, lock=False):
    statement = select(CatalogState).where(CatalogState.key == "global")
    state = db.scalar(statement.with_for_update() if lock else statement)
    if state is None:
        raise DomainError(503, "storage_unavailable", "Catalog state is missing")
    return state


def current_plant(db, plant_id):
    state = current_catalog_id(db)
    if state.current_version_id is None:
        return None
    return db.get(PlantVersion, (state.current_version_id, plant_id))


def create_snapshot(db, access, body, *, plant_id=None):
    from services.api.use_cases import canonical_hash, uid

    normalized, changed_synthetic = canonicalize_plant_input(db, body)
    state = current_catalog_id(db, lock=True)
    previous = []
    if state.current_version_id:
        previous = list(
            db.scalars(
                select(PlantVersion)
                .where(PlantVersion.catalog_version_id == state.current_version_id)
                .order_by(PlantVersion.plant_id)
            )
        )
    creating = plant_id is None
    if creating:
        plant_id = uid()
        db.add(PlantIdentity(id=plant_id))
        db.flush()
    elif not any(row.plant_id == plant_id for row in previous):
        raise DomainError(404, "not_found", "Plant was not found in the current catalog")

    catalog_id = uid()
    changed = {"id": plant_id, "version_id": catalog_id, **normalized}
    payloads = []
    for row in previous:
        if row.plant_id == plant_id:
            continue
        payloads.append({**row.payload, "version_id": catalog_id})
    payloads.append(changed)
    payloads.sort(key=lambda value: value["id"])
    source_version_ids = {
        source["dataset_version_id"]
        for payload in payloads
        for trait in payload["traits"]
        for source in trait["source_refs"]
    }
    synthetic = changed_synthetic or any(
        version.synthetic
        for version in db.scalars(
            select(DatasetVersion).where(DatasetVersion.id.in_(source_version_ids))
        )
    )
    created_at = datetime.now(UTC)
    manifest = {
        "id": catalog_id,
        "created_at": created_at.isoformat().replace("+00:00", "Z"),
        "plant_count": len(payloads),
        "input_hash": canonical_hash(payloads),
        "synthetic": synthetic,
    }
    db.add(
        CatalogVersion(
            id=catalog_id,
            actor_id=access.user.id,
            created_at=created_at,
            synthetic=synthetic,
            payload=manifest,
        )
    )
    db.flush()
    for payload in payloads:
        db.add(
            PlantVersion(
                catalog_version_id=catalog_id,
                plant_id=payload["id"],
                payload=payload,
            )
        )
    state.current_version_id = catalog_id
    return changed


def promote_rule_versions(db, dataset, version):
    if dataset.payload["kind"] != "restrictions":
        return
    for record in db.scalars(
        select(ImportRecord)
        .where(ImportRecord.version_id == version.id)
        .order_by(ImportRecord.row_index)
    ):
        properties = record.payload.get("properties", {})
        if properties.get("record_type") != "rule_version":
            continue
        candidate = {
            "id": properties.get("id"),
            "source": {
                "dataset_version_id": version.id,
                "source_record_id": record.payload.get("source_record_id"),
                "label": dataset.payload["name"],
                "uri": dataset.payload["source_uri"],
            },
            "act_number": properties.get("act_number"),
            "clause": properties.get("clause"),
            "revision_date": properties.get("revision_date"),
            "parameter": properties.get("parameter"),
            "value": properties.get("value"),
            "unit": properties.get("unit"),
            "applicability": properties.get("applicability"),
            "condition": properties.get("condition"),
            "review_status": properties.get("review_status"),
            "source_status": properties.get("source_status"),
            "superseded_by": properties.get("superseded_by"),
        }
        try:
            validate("RuleVersion", candidate)
        except ValidationError as error:
            raise DomainError(
                422,
                "rule_record_invalid",
                f"Rule source record {record.payload.get('source_record_id')} is invalid: {error.message}",
            ) from None
        try:
            UUID(candidate["id"])
        except (ValueError, TypeError):
            raise DomainError(422, "rule_record_invalid", "Rule id must be a UUID") from None
        existing = db.get(RuleVersionRecord, candidate["id"])
        if existing:
            raise DomainError(409, "rule_version_conflict", "Rule version id is already registered")
        db.add(
            RuleVersionRecord(
                id=candidate["id"],
                dataset_id=dataset.id,
                dataset_version_id=version.id,
                payload=candidate,
            )
        )


def promote_stock_items(db, dataset, version):
    if dataset.payload["kind"] != "stock":
        return
    for record in db.scalars(
        select(ImportRecord)
        .where(ImportRecord.version_id == version.id)
        .order_by(ImportRecord.row_index)
    ):
        properties = record.payload.get("properties", {})
        if properties.get("record_type") != "stock_item":
            continue
        source_record_id = record.payload.get("source_record_id")
        item_id = str(
            uuid5(
                NAMESPACE_URL,
                f"pavlodar:stock:{version.id}:{source_record_id or record.row_index}",
            )
        )
        candidate = {
            "id": item_id,
            "plant_id": properties.get("plant_id"),
            "supplier": properties.get("supplier"),
            "size_description": properties.get("size_description"),
            "available_quantity": properties.get("available_quantity"),
            "unit_price": properties.get("unit_price"),
            "currency": properties.get("currency"),
            "observed_at": properties.get("observed_at"),
            "source_refs": [
                {
                    "dataset_version_id": version.id,
                    "source_record_id": source_record_id,
                    "label": dataset.payload["name"],
                    "uri": dataset.payload["source_uri"],
                }
            ],
            "availability": properties.get("availability"),
            "supplier_city": properties.get("supplier_city"),
            "is_local_supply": properties.get("is_local_supply"),
            "height_min_m": properties.get("height_min_m"),
            "height_max_m": properties.get("height_max_m"),
            "container": properties.get("container"),
            "root_system": properties.get("root_system"),
            "tax_mode": properties.get("tax_mode"),
            "stock_counted_at": properties.get("stock_counted_at"),
            "checked_at": properties.get("checked_at"),
            "applicability": properties.get("applicability"),
        }
        try:
            validate("StockItem", candidate)
        except ValidationError as error:
            raise DomainError(
                422,
                "stock_record_invalid",
                f"Stock source record {source_record_id or record.row_index} is invalid: {error.message}",
            ) from None
        if db.get(PlantIdentity, candidate["plant_id"]) is None:
            raise DomainError(422, "stock_record_invalid", "Stock plant is not registered")
        if (
            candidate["height_min_m"] is not None
            and candidate["height_max_m"] is not None
            and candidate["height_min_m"] > candidate["height_max_m"]
        ):
            raise DomainError(422, "stock_record_invalid", "Stock height range is reversed")
        if candidate["available_quantity"] is not None and candidate["stock_counted_at"] is None:
            raise DomainError(
                422, "stock_record_invalid", "Known stock quantity requires stock_counted_at"
            )
        if candidate["availability"] in {"in_stock", "not_in_stock", "vendor_reported"} and candidate["checked_at"] is None:
            raise DomainError(
                422, "stock_record_invalid", "Reported stock availability requires checked_at"
            )
        db.add(
            StockItemRecord(
                id=item_id,
                plant_id=candidate["plant_id"],
                city_id=dataset.city_id,
                dataset_id=dataset.id,
                dataset_version_id=version.id,
                payload=candidate,
            )
        )


def authorized_stock(db, access, stock_item_id, *, city_id=None):
    record = db.get(StockItemRecord, stock_item_id)
    if record is None:
        raise DomainError(404, "not_found", "Stock item was not found")
    access.dataset(db.get(Dataset, record.dataset_id))
    if city_id is not None and record.city_id != city_id:
        raise DomainError(422, "stock_item_unavailable", "Stock item belongs to another city")
    return record


def promote_survival_models(db, dataset, version):
    if dataset.payload["kind"] != "models":
        return
    for record in db.scalars(
        select(ImportRecord)
        .where(ImportRecord.version_id == version.id)
        .order_by(ImportRecord.row_index)
    ):
        properties = record.payload.get("properties", {})
        if properties.get("record_type") != "survival_model":
            continue
        source_record_id = record.payload.get("source_record_id")
        model_id = str(
            uuid5(
                NAMESPACE_URL,
                f"pavlodar:survival-model:{version.id}:{source_record_id or record.row_index}",
            )
        )
        candidate = {
            "id": model_id,
            "city_id": dataset.city_id,
            "model_kind": properties.get("model_kind"),
            "calibration_status": properties.get("calibration_status"),
            "applicability": properties.get("applicability"),
            "qualitative_confidence": properties.get("qualitative_confidence"),
            "points": properties.get("points"),
            "source_refs": [
                {
                    "dataset_version_id": version.id,
                    "source_record_id": source_record_id,
                    "label": dataset.payload["name"],
                    "uri": dataset.payload["source_uri"],
                }
            ],
            "checked_at": properties.get("checked_at"),
            "expert_status": properties.get("expert_status"),
        }
        try:
            validate("SurvivalModelVersion", candidate)
        except ValidationError as error:
            raise DomainError(
                422,
                "model_version_unavailable",
                f"Survival model record {source_record_id or record.row_index} is invalid: {error.message}",
            ) from None
        if candidate["calibration_status"] == "locally_validated":
            raise DomainError(
                422,
                "model_version_unavailable",
                "Local validation requires the unavailable DR-04 acceptance pipeline",
            )
        if candidate["expert_status"] == "approved":
            if candidate["calibration_status"] != "expert_confirmed":
                raise DomainError(
                    422,
                    "model_version_unavailable",
                    "Approved model must be expert-confirmed",
                )
            years = [point["year"] for point in candidate["points"]]
            if years != [1, 2, 3] or any(
                point[key] is None
                for point in candidate["points"]
                for key in ("probability", "lower", "upper")
            ):
                raise DomainError(
                    422,
                    "model_version_unavailable",
                    "Approved model needs complete year 1/2/3 intervals",
                )
            if any(
                not point["lower"] <= point["probability"] <= point["upper"]
                for point in candidate["points"]
            ):
                raise DomainError(
                    422, "model_version_unavailable", "Survival interval is inconsistent"
                )
            probabilities = [point["probability"] for point in candidate["points"]]
            if probabilities != sorted(probabilities, reverse=True):
                raise DomainError(
                    422, "model_version_unavailable", "Survival must not increase over time"
                )
        if version.synthetic and not _complete_survival_points(candidate["points"]):
            raise DomainError(
                422,
                "model_version_unavailable",
                "Synthetic estimate needs complete monotone year 1/2/3 intervals",
            )
        db.add(
            SurvivalModelRecord(
                id=model_id,
                city_id=dataset.city_id,
                dataset_id=dataset.id,
                dataset_version_id=version.id,
                payload=candidate,
            )
        )


def _complete_survival_points(points):
    if [point["year"] for point in points] != [1, 2, 3]:
        return False
    if any(point[key] is None for point in points for key in ("probability", "lower", "upper")):
        return False
    if any(not point["lower"] <= point["probability"] <= point["upper"] for point in points):
        return False
    probabilities = [point["probability"] for point in points]
    return probabilities == sorted(probabilities, reverse=True)


def authorized_model(db, access, model_version_id, *, city_id=None, usable=False):
    record = db.get(SurvivalModelRecord, model_version_id)
    if record is None:
        raise DomainError(404, "not_found", "Survival model was not found")
    access.dataset(db.get(Dataset, record.dataset_id))
    if city_id is not None and record.city_id != city_id:
        raise DomainError(422, "model_version_unavailable", "Model belongs to another city")
    if usable:
        source_version = db.get(DatasetVersion, record.dataset_version_id)
        approved = (
            record.payload["expert_status"] == "approved"
            and record.payload["calibration_status"] != "uncalibrated"
        )
        explicit_estimate = (
            source_version.synthetic
            and record.payload["expert_status"] == "pending"
            and record.payload["calibration_status"] == "uncalibrated"
            and _complete_survival_points(record.payload["points"])
        )
        if not approved and not explicit_estimate:
            raise DomainError(
                422,
                "model_version_unavailable",
                "Model is neither approved nor an explicit complete synthetic estimate",
            )
    return record


def authorized_rule(db, access, rule_id, *, city_id=None):
    record = db.get(RuleVersionRecord, rule_id)
    if record is None:
        raise DomainError(404, "not_found", "Rule version was not found")
    dataset = db.get(Dataset, record.dataset_id)
    access.dataset(dataset)
    if city_id is not None and dataset.city_id != city_id:
        raise DomainError(422, "rule_version_unavailable", "Rule belongs to another city")
    return record


def usable_rule(db, access, rule_id, *, city_id):
    record = authorized_rule(db, access, rule_id, city_id=city_id)
    payload = record.payload
    source_version = db.get(DatasetVersion, record.dataset_version_id)
    usable_estimate = (
        source_version.synthetic
        and payload["review_status"] == "verified_text_requires_expert"
    )
    if (
        payload["review_status"] != "expert_confirmed"
        and not usable_estimate
    ) or payload["superseded_by"] is not None:
        raise DomainError(
            422,
            "rule_version_unavailable",
            "Rule must be expert-confirmed or an explicit synthetic estimate, and not superseded",
        )
    return record


def catalog_plants(db, catalog_version_id):
    catalog = db.get(CatalogVersion, catalog_version_id)
    if catalog is None:
        raise DomainError(422, "catalog_version_unavailable", "Catalog snapshot was not found")
    rows = list(
        db.scalars(
            select(PlantVersion)
            .where(PlantVersion.catalog_version_id == catalog_version_id)
            .order_by(PlantVersion.plant_id)
        )
    )
    return catalog, rows


def intrinsic_eligibility(plant, purpose, *, explicitly_excluded=False):
    blockers = []
    eligibility = "eligible"
    if explicitly_excluded:
        eligibility = "excluded"
        blockers.append(
            data_gap("plant_explicitly_excluded", "Вид исключён пользователем", plant["id"])
        )
    elif plant["expert_status"] == "rejected":
        eligibility = "excluded"
        blockers.append(
            data_gap("plant_expert_rejected", "Вид отклонён экспертом", plant["id"])
        )
    elif purpose in SENSITIVE_PURPOSES and plant["sensitive_site_status"] == "excluded":
        eligibility = "excluded"
        blockers.append(
            data_gap(
                "plant_sensitive_site_excluded",
                plant["exclusion_reason"] or "Вид исключён для чувствительной территории",
                plant["id"],
            )
        )
    else:
        if plant["expert_status"] != "approved":
            blockers.append(
                data_gap(
                    "plant_expert_review_required",
                    "Нужно решение профильного эксперта",
                    "DR-02",
                )
            )
        if plant["taxon_rank"] == "genus":
            blockers.append(
                data_gap(
                    "plant_taxon_requires_review",
                    "Запись рода нельзя применять как конкретный вид/сорт",
                    "DR-02",
                )
            )
        if plant["allergy_risk"] == "unknown" or plant["toxicity_risk"] == "unknown":
            blockers.append(
                data_gap(
                    "plant_safety_unknown",
                    "Аллергенность или токсичность не подтверждена",
                    "DR-02",
                )
            )
        if plant["local_evidence"] is None:
            blockers.append(
                data_gap(
                    "plant_local_evidence_missing",
                    "Нет локального подтверждения применимости",
                    "DR-02",
                )
            )
        if purpose in SENSITIVE_PURPOSES and plant["sensitive_site_status"] == "requires_review":
            blockers.append(
                data_gap(
                    "plant_sensitive_site_review",
                    "Нужна отдельная проверка для школы/больницы",
                    "DR-02",
                )
            )
        blockers.extend(item for item in plant["review_reasons"] if item["blocking"])
        if blockers:
            eligibility = "requires_review"
    return eligibility, blockers


def recommend(db, access, body, zone_version):
    from services.api.models import Zone

    zone = db.scalar(select(Zone).where(Zone.current_version_id == zone_version.id))
    if zone is None:
        zone = db.get(Zone, zone_version.zone_id)
    access.city(zone.city_id)
    usable_rule(db, access, body["rule_version_id"], city_id=zone.city_id)
    _, rows = catalog_plants(db, body["catalog_version_id"])

    excluded = body["excluded_plant_ids"]
    locked = body["locked_plant_ids"]
    if len(excluded) != len(set(excluded)) or len(locked) != len(set(locked)):
        raise DomainError(422, "recommendation_selection_invalid", "Plant selections are duplicated")
    if set(excluded) & set(locked) or len(locked) > body["top_n"]:
        raise DomainError(
            422,
            "recommendation_selection_invalid",
            "Locked plants cannot be excluded and must fit top_n",
        )
    known_ids = {row.plant_id for row in rows}
    if not set(excluded + locked) <= known_ids:
        raise DomainError(422, "recommendation_selection_invalid", "Selected plant is not in catalog")
    factors = [item["factor"] for item in body["weights"]]
    total_weight = sum(item["weight"] for item in body["weights"])
    if not factors or len(factors) != len(set(factors)) or total_weight <= 0:
        raise DomainError(
            422, "recommendation_weights_invalid", "Weights must be unique and total above zero"
        )

    candidates = []
    for row in rows:
        plant = row.payload
        eligibility, blockers = intrinsic_eligibility(
            plant,
            zone_version.payload["purpose"],
            explicitly_excluded=plant["id"] in excluded,
        )
        traits = {item["key"]: item for item in plant["traits"]}
        contributions = []
        known_weight = 0.0
        weighted = 0.0
        for requested in body["weights"]:
            trait = traits.get(requested["factor"])
            score = None
            sources = []
            if (
                trait
                and trait["status"] == "known"
                and trait["value_number"] is not None
                and trait["unit"] == "1"
                and 0 <= trait["value_number"] <= 1
            ):
                score = float(trait["value_number"])
                sources = trait["source_refs"]
                known_weight += requested["weight"]
                weighted += score * requested["weight"]
                explanation = "Использовано нормированное значение 0..1 из версии каталога"
            else:
                explanation = "Нет нормированного sourced значения 0..1; вклад не рассчитан"
                blockers.append(
                    data_gap(
                        "plant_trait_missing",
                        f"Нет проверенного признака {requested['factor']}",
                        plant["id"],
                    )
                )
                if eligibility == "eligible":
                    eligibility = "requires_review"
            contributions.append(
                {
                    "factor": requested["factor"],
                    "score": score,
                    "weight": requested["weight"],
                    "explanation": explanation,
                    "source_refs": sources,
                }
            )
        coverage = known_weight / total_weight
        score = (
            round(weighted / total_weight * 100, 6)
            if eligibility != "excluded" and coverage == 1.0
            else None
        )
        candidates.append(
            {
                "plant_id": plant["id"],
                "eligibility": eligibility,
                "score": score,
                "data_coverage": coverage,
                "contributions": contributions,
                "blockers": blockers,
                "_locked": plant["id"] in locked,
            }
        )
    rank = {"eligible": 0, "requires_review": 1, "excluded": 2}
    candidates.sort(
        key=lambda item: (
            not item["_locked"],
            rank[item["eligibility"]],
            -(item["score"] if item["score"] is not None else -1),
            item["plant_id"],
        )
    )
    result = []
    for item in candidates[: body["top_n"]]:
        result.append({key: value for key, value in item.items() if key != "_locked"})
    return {
        "zone_version_id": zone_version.id,
        "rule_version_id": body["rule_version_id"],
        "candidates": result,
    }


def _validate_building_conflicts(db, body, previous_placements):
    """Reject new or moved points covered by a frozen published building footprint.

    Existing unchanged positions are grandfathered: admitting a newly published building version
    must not make an unrelated scenario edit impossible.  A move, however, is checked by PostGIS
    against the exact building dataset versions frozen into the proposed revision.
    """
    building_versions = []
    for version_id in body["dataset_version_ids"]:
        version = db.get(DatasetVersion, version_id)
        dataset = db.get(Dataset, version.dataset_id) if version else None
        if version and dataset and dataset.payload.get("kind") == "buildings":
            building_versions.append(version_id)
    if not building_versions:
        return
    previous = {
        item["id"]: item["position"]["coordinates"][:2]
        for item in (previous_placements or [])
    }
    for index, placement in enumerate(body["placements"]):
        coordinates = placement["position"]["coordinates"][:2]
        if previous.get(placement["id"]) == coordinates:
            continue
        point = func.ST_SetSRID(func.ST_Point(coordinates[0], coordinates[1]), 4326)
        conflict = db.scalar(
            select(ImportRecord.row_index)
            .where(
                ImportRecord.version_id.in_(building_versions),
                ImportRecord.geometry.is_not(None),
                func.ST_Covers(ImportRecord.geometry, point),
            )
            .limit(1)
        )
        if conflict is not None:
            raise DomainError(
                422,
                "placement_building_conflict",
                "Посадка пересекает контур здания",
                field_errors=[
                    {
                        "path": f"/placements/{index}/position",
                        "code": "building_conflict",
                        "message": "Посадка пересекает здание",
                    }
                ],
            )


def _validate_crown_clearance(body):
    """Reject overlap only when both saved crown radii are known.

    This is a geometric footprint check, not a species-specific planting norm. Unknown dimensions
    remain unknown and never block saving. Coordinates are measured in Pavlodar's metric UTM zone;
    exact tangency is valid and a tiny tolerance avoids floating-point false positives.
    """
    known = []
    for index, placement in enumerate(body["placements"]):
        radius = placement["initial_crown_radius_m"]
        if placement["dimension_basis"] == "unknown" or radius is None or radius <= 0:
            continue
        point = transform(PROJECT, Point(placement["position"]["coordinates"][:2]))
        known.append((index, point, float(radius)))
    conflicts = set()
    for offset, (left_index, left_point, left_radius) in enumerate(known):
        for right_index, right_point, right_radius in known[offset + 1 :]:
            if left_point.distance(right_point) + 1e-6 < left_radius + right_radius:
                conflicts.update((left_index, right_index))
    if conflicts:
        raise DomainError(
            422,
            "placement_spacing_conflict",
            "Контуры известных крон пересекаются",
            field_errors=[
                {
                    "path": f"/placements/{index}/position",
                    "code": "crown_overlap",
                    "message": "Известная крона пересекается с другой посадкой",
                }
                for index in sorted(conflicts)
            ],
        )


def validate_scenario_registry(
    db, access, scenario, zone_version, body, previous_placements=None
):
    catalog_synthetic = False
    catalog = None
    rows = []
    if body["catalog_version_id"] is not None:
        catalog, rows = catalog_plants(db, body["catalog_version_id"])
        catalog_synthetic = catalog.synthetic
    if body["rule_version_id"] is not None:
        usable_rule(db, access, body["rule_version_id"], city_id=scenario.city_id)
    if not body["placements"] and not body["area_patches"]:
        return catalog_synthetic
    if body["catalog_version_id"] is None:
        raise DomainError(
            422,
            "registry_inputs_unavailable",
            "Placements require catalog_version_id",
        )
    plants = {row.plant_id: row.payload for row in rows}
    zone_shape = shape(zone_version.payload["geometry"])
    identities = [item["id"] for item in body["placements"]] + [
        item["id"] for item in body["area_patches"]
    ]
    if len(identities) != len(set(identities)):
        raise DomainError(422, "plant_input_invalid", "Placement and patch ids must be unique")
    for placement in body["placements"]:
        plant = plants.get(placement["plant_id"])
        if plant is None:
            raise DomainError(422, "catalog_version_unavailable", "Placement plant is not in catalog")
        eligibility, _ = intrinsic_eligibility(plant, zone_version.payload["purpose"])
        if eligibility == "excluded":
            raise DomainError(422, "placement_plant_excluded", "Excluded plant cannot be placed")
        if not zone_shape.covers(Point(placement["position"]["coordinates"][:2])):
            raise DomainError(422, "placement_outside_zone", "Placement is outside zone geometry")
        if placement["stock_item_id"] is not None:
            stock = authorized_stock(
                db, access, placement["stock_item_id"], city_id=scenario.city_id
            )
            if stock.dataset_version_id not in body["dataset_version_ids"]:
                raise DomainError(
                    422,
                    "stock_item_unavailable",
                    "Stock dataset version must be frozen in the scenario revision",
                )
            if stock.plant_id != placement["plant_id"]:
                raise DomainError(
                    422, "stock_item_unavailable", "Stock item belongs to another plant"
                )
            quantity = stock.payload["available_quantity"]
            if stock.payload["availability"] == "not_in_stock" or (
                quantity is not None and quantity < placement["quantity"]
            ):
                raise DomainError(
                    422, "stock_item_unavailable", "Stock quantity is insufficient"
                )
        dimensions = (placement["initial_height_m"], placement["initial_crown_radius_m"])
        if placement["dimension_basis"] == "unknown" and any(v is not None for v in dimensions):
            raise DomainError(
                422, "plant_input_invalid", "Unknown dimension basis cannot carry dimensions"
            )
    _validate_crown_clearance(body)
    _validate_building_conflicts(db, body, previous_placements)
    for patch in body["area_patches"]:
        plant = plants.get(patch["plant_id"])
        if plant is None:
            raise DomainError(422, "catalog_version_unavailable", "Patch plant is not in catalog")
        eligibility, _ = intrinsic_eligibility(plant, zone_version.payload["purpose"])
        if eligibility == "excluded":
            raise DomainError(422, "placement_plant_excluded", "Excluded plant cannot be patched")
        patch_shape = shape(patch["geometry"])
        if not zone_shape.covers(patch_shape):
            raise DomainError(422, "placement_outside_zone", "Area patch is outside zone geometry")
    return catalog_synthetic
