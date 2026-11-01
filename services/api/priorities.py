"""Versioned, source-aware city priority calculation.

The first method deliberately uses only ratios already present in ZoneContext.
It has no locally invented climatic, social, or ecological thresholds.
"""

from datetime import UTC, datetime

from packages.domain.errors import DomainError
from services.api.models import Dataset, DatasetVersion, PriorityResultRecord
from services.api.use_cases import found, get_zone
from services.api.zone_context import build_zone_context

NORMALIZATION_VERSION_ID = "f5f9b550-42ab-5bfd-bf5e-2c442ad5e254"
METHOD_VERSION = "zone-context-ratios-1"
NORMALIZATION = {
    "id": NORMALIZATION_VERSION_ID,
    "name": "Доли контекста зоны v1",
    "method_version": METHOD_VERSION,
    "factors": [
        {
            "factor": "green_deficit",
            "label": "Дефицит существующего озеленения",
            "group": "need",
            "formula": "1 - clamp(existing_green_area / zone_area, 0, 1)",
            "unit": "1",
            "minimum": 0.0,
            "maximum": 1.0,
        },
        {
            "factor": "soil_coverage",
            "label": "Покрытие почвенными данными",
            "group": "readiness",
            "formula": "clamp(soil_coverage_fraction, 0, 1)",
            "unit": "1",
            "minimum": 0.0,
            "maximum": 1.0,
        },
    ],
    "created_at": "2026-10-30T00:00:00Z",
}
FACTOR_BY_KEY = {item["factor"]: item for item in NORMALIZATION["factors"]}


def list_normalizations():
    return {
        "items": [NORMALIZATION],
        "next_cursor": None,
    }


def _unique_source_refs(*groups):
    values = {}
    for group in groups:
        for ref in group:
            values[(ref["dataset_version_id"], ref.get("source_record_id"))] = ref
    return [values[key] for key in sorted(values)]


def _factor_value(factor, metrics):
    if factor == "green_deficit":
        green = metrics.get("existing_green_area")
        area = metrics.get("zone_area")
        if not green or not area or green["value"] is None or not area["value"]:
            return None, [], "Недостаточно данных о площади существующей зелени"
        ratio = float(green["value"]) / float(area["value"])
        return (
            1.0 - min(1.0, max(0.0, ratio)),
            _unique_source_refs(green["source_refs"], area["source_refs"]),
            "Доля незанятой существующей зеленью площади зоны",
        )
    if factor == "soil_coverage":
        soil = metrics.get("soil_coverage_fraction")
        if not soil or soil["value"] is None:
            return None, [], "Недостаточно данных о покрытии почвенным слоем"
        return (
            min(1.0, max(0.0, float(soil["value"]))),
            list(soil["source_refs"]),
            "Доля зоны, покрытая доступными почвенными данными",
        )
    raise AssertionError(f"unsupported registered factor: {factor}")


def _weighted_score(contributions, weights, group=None):
    selected = [
        item
        for item in contributions
        if (group is None or FACTOR_BY_KEY[item["factor"]]["group"] == group)
        and weights[item["factor"]] > 0
    ]
    if not selected or any(item["score"] is None for item in selected):
        return None
    denominator = sum(weights[item["factor"]] for item in selected)
    return round(
        sum(item["score"] * weights[item["factor"]] for item in selected)
        / denominator
        * 100,
        6,
    )


def calculate_priorities(db, access, body, result_id, created_at):
    access.city(body["city_id"])
    if body["normalization_version_id"] != NORMALIZATION_VERSION_ID:
        raise DomainError(
            422,
            "priority_normalization_unavailable",
            "Requested priority normalization version is unavailable",
        )
    if len(body["zone_ids"]) != len(set(body["zone_ids"])):
        raise DomainError(422, "priority_zones_invalid", "Priority zones must be unique")
    factors = [item["factor"] for item in body["weights"]]
    if len(factors) != len(set(factors)) or not set(factors) <= set(FACTOR_BY_KEY):
        raise DomainError(
            422,
            "priority_weights_invalid",
            "Priority weights must be unique and use registered factors",
        )
    weights = {item["factor"]: float(item["weight"]) for item in body["weights"]}
    total_weight = sum(weights.values())
    if total_weight <= 0:
        raise DomainError(422, "priority_weights_invalid", "Weight total must be above zero")

    zones = []
    for zone_id in body["zone_ids"]:
        zone, version = get_zone(db, access, zone_id)
        if zone.city_id != body["city_id"]:
            raise DomainError(422, "city_mismatch", "Every zone must belong to the city")
        context = build_zone_context(db, access, zone, version)
        metrics = {item["key"]: item for item in context["metrics"]}
        contributions = []
        known_weight = 0.0
        for requested in body["weights"]:
            value, refs, explanation = _factor_value(requested["factor"], metrics)
            if value is not None:
                known_weight += weights[requested["factor"]]
            contributions.append(
                {
                    "factor": requested["factor"],
                    "score": value,
                    "weight": requested["weight"],
                    "explanation": explanation,
                    "source_refs": refs,
                }
            )
        zones.append(
            {
                "zone_id": zone.id,
                "score": _weighted_score(contributions, weights),
                "need_score": _weighted_score(contributions, weights, "need"),
                "readiness_score": _weighted_score(contributions, weights, "readiness"),
                "data_coverage": round(known_weight / total_weight, 6),
                "contributions": contributions,
            }
        )
    payload = {
        "id": result_id,
        "city_id": body["city_id"],
        "weights": body["weights"],
        "normalization_version_id": body["normalization_version_id"],
        "zones": zones,
        "created_at": created_at,
    }
    db.add(
        PriorityResultRecord(
            id=result_id,
            city_id=body["city_id"],
            actor_id=access.user.id,
            normalization_version_id=body["normalization_version_id"],
            payload=payload,
            created_at=datetime.fromisoformat(created_at).astimezone(UTC),
        )
    )
    return payload


def authorized_priority_result(db, access, result_id):
    record = found(db.get(PriorityResultRecord, result_id))
    access.city(record.city_id)
    if record.actor_id != access.user.id and access.level < 2:
        raise DomainError(404, "not_found", "Object not found")
    version_ids = {
        ref["dataset_version_id"]
        for zone in record.payload["zones"]
        for contribution in zone["contributions"]
        for ref in contribution["source_refs"]
    }
    for version_id in version_ids:
        version = found(db.get(DatasetVersion, version_id))
        access.dataset(found(db.get(Dataset, version.dataset_id)))
    return record


def get_priority_result(db, access, result_id):
    record = authorized_priority_result(db, access, result_id)
    return record.payload
