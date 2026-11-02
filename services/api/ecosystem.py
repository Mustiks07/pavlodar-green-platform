"""Source-backed ecosystem indicators for immutable scenario revisions."""

import math
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

from shapely.geometry import shape
from shapely.ops import transform
from sqlalchemy import select

from packages.domain.errors import gap
from packages.geo.geometry import PROJECT
from services.api.models import (
    CoefficientVersionRecord,
    DatasetVersion,
    ImportRecord,
    PlantVersion,
    ZoneVersion,
)

HORIZONS = (5, 10, 20)
METRICS = (
    ("co2_sequestered", "t_CO2_per_year"),
    ("pollutants_removed", "kg_per_year"),
    ("oxygen_produced", "kg_per_year"),
    ("air_cooling", "degC"),
    ("stormwater_retained", "m3"),
    ("green_area", "m2"),
    ("green_area_per_person", "m2"),
)
COUNT_BASES = {"per_plant_year", "per_tree_year", "per_shrub_year"}
FLOW_KEYS = {
    "co2_sequestered",
    "pollutants_removed",
    "oxygen_produced",
    "stormwater_retained",
}


@dataclass(frozen=True)
class CoefficientRow:
    metric_key: str
    value: Decimal
    unit: str
    basis: str
    horizon_factors: dict | None
    source_ref: dict
    qualitative_confidence: str


@dataclass(frozen=True)
class PopulationRow:
    count: Decimal
    source_ref: dict
    qualitative_confidence: str


def _decimal(value):
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None
    return parsed if parsed.is_finite() and math.isfinite(float(parsed)) else None


def _horizon_factor(row, horizon):
    if row.horizon_factors is None:
        return Decimal(1)
    if not isinstance(row.horizon_factors, dict):
        return None
    return _decimal(row.horizon_factors.get(str(horizon)))


def _missing_metric(key, unit, horizon, missing_reason=None):
    return {
        "key": key,
        "value": None,
        "unit": unit,
        "horizon_year": horizon,
        "status": "unavailable",
        "lower": None,
        "upper": None,
        "qualitative_confidence": "unknown",
        "method_version": "ecosystem-source-profile-v1",
        "source_refs": [],
        "missing_reason": missing_reason or gap(
            "ecosystem_coefficient_unavailable",
            "Для показателя нет поддерживаемого опубликованного коэффициента или входа",
            key,
            "coefficient_version_id",
            "DR-06",
        ),
    }


def _metric(key, unit, horizon, value, status, source_refs, qualitative_confidence):
    return {
        "key": key,
        "value": float(value),
        "unit": unit,
        "horizon_year": horizon,
        "status": status,
        "lower": None,
        "upper": None,
        "qualitative_confidence": qualitative_confidence,
        "method_version": "ecosystem-source-profile-v1",
        "source_refs": source_refs,
        "missing_reason": None,
    }


def _unique_refs(refs):
    result, seen = [], set()
    for ref in refs:
        identity = (ref["dataset_version_id"], ref["source_record_id"])
        if identity not in seen:
            seen.add(identity)
            result.append(ref)
    return result


def _confidence(value):
    return value if value in {"high", "medium", "low", "unknown"} else "unknown"


def _combined_confidence(values):
    values = [_confidence(value) for value in values]
    if not values or "unknown" in values:
        return "unknown"
    return min(values, key={"low": 0, "medium": 1, "high": 2}.get)


def _placement_counts(db, revision):
    placements = revision.payload.get("placements") or []
    patches = revision.payload.get("area_patches") or []
    plant_ids = {item.get("plant_id") for item in placements if item.get("plant_id")}
    plant_ids.update(item.get("plant_id") for item in patches if item.get("plant_id"))
    plants = {}
    if revision.payload.get("catalog_version_id") and plant_ids:
        rows = db.scalars(
            select(PlantVersion).where(
                PlantVersion.catalog_version_id == revision.payload["catalog_version_id"],
                PlantVersion.plant_id.in_(plant_ids),
            )
        ).all()
        plants = {row.plant_id: row.payload for row in rows}
    counts = {
        "per_plant_year": Decimal(0),
        "per_tree_year": Decimal(0),
        "per_shrub_year": Decimal(0),
    }
    for placement in placements:
        quantity = _decimal(placement.get("quantity"))
        if quantity is None:
            continue
        counts["per_plant_year"] += quantity
        stratum = (plants.get(placement.get("plant_id")) or {}).get("stratum")
        if stratum == "tree":
            counts["per_tree_year"] += quantity
        elif stratum == "shrub":
            counts["per_shrub_year"] += quantity
    density_missing = []
    for patch in patches:
        density = _decimal(patch.get("density_plants_per_m2"))
        if density is None:
            density_missing.append(patch["id"])
            continue
        area = _decimal(transform(PROJECT, shape(patch["geometry"])).area)
        if area is None or area <= 0:
            density_missing.append(patch["id"])
            continue
        quantity = area * density
        counts["per_plant_year"] += quantity
        stratum = (plants.get(patch.get("plant_id")) or {}).get("stratum")
        if stratum == "tree":
            counts["per_tree_year"] += quantity
        elif stratum == "shrub":
            counts["per_shrub_year"] += quantity
    if density_missing:
        counts = {key: None for key in counts}
    return counts, density_missing


def _profile_rows(db, revision):
    version_id = revision.payload.get("coefficient_version_id")
    if not version_id:
        return None, []
    coefficient = db.get(CoefficientVersionRecord, version_id)
    if coefficient is None:
        return None, []
    version = db.get(DatasetVersion, coefficient.dataset_version_id)
    if version is None or version.status != "published":
        return None, []
    canonical_refs = {
        ref["source_record_id"]: ref
        for ref in coefficient.payload.get("source_refs", [])
        if ref.get("dataset_version_id") == version.id and ref.get("source_record_id")
    }
    if not canonical_refs:
        return version, []
    records = db.scalars(
        select(ImportRecord).where(
            ImportRecord.version_id == version.id,
            ImportRecord.payload["source_record_id"].astext.in_(canonical_refs),
        )
    ).all()
    rows = []
    for record in records:
        source_record_id = record.payload.get("source_record_id")
        source_ref = canonical_refs.get(source_record_id)
        properties = record.payload.get("properties")
        if source_ref is None or not isinstance(properties, dict):
            continue
        metric_key = properties.get("metric_key")
        basis = properties.get("basis")
        unit = properties.get("unit")
        value = _decimal(properties.get("value"))
        if (
            properties.get("record_type") != "ecosystem_coefficient"
            or metric_key not in {item[0] for item in METRICS}
            or not isinstance(unit, str)
            or not unit.strip()
            or value is None
        ):
            continue
        supported = (
            metric_key == "green_area"
            and basis in COUNT_BASES
            or metric_key == "air_cooling"
            and basis == "green_fraction"
            or metric_key in FLOW_KEYS
            and basis in COUNT_BASES | {"per_green_m2_year"}
        )
        if not supported:
            continue
        rows.append(
            CoefficientRow(
                metric_key=metric_key,
                value=value,
                unit=unit.strip(),
                basis=basis,
                horizon_factors=properties.get("horizon_factors"),
                source_ref=source_ref,
                qualitative_confidence=_confidence(
                    properties.get("qualitative_confidence")
                ),
            )
        )
    return version, rows


def _population_row(db, revision, zone):
    """Read one population input from the exact published versions frozen in this revision."""
    if zone is None:
        return None
    version_ids = []
    for version_id in revision.payload.get("dataset_version_ids") or []:
        version = db.get(DatasetVersion, version_id)
        if version is not None and version.status == "published":
            version_ids.append(version_id)
    if not version_ids:
        return None
    records = db.scalars(
        select(ImportRecord).where(ImportRecord.version_id.in_(version_ids))
    ).all()
    matches = []
    for record in records:
        properties = record.payload.get("properties")
        source_record_id = record.payload.get("source_record_id")
        if (
            not isinstance(properties, dict)
            or properties.get("record_type") != "population_input"
            or properties.get("zone_id") != zone.zone_id
            or not source_record_id
        ):
            continue
        count = _decimal(properties.get("population_count"))
        if count is None or count <= 0:
            continue
        matches.append(
            PopulationRow(
                count=count,
                source_ref={
                    "dataset_version_id": record.version_id,
                    "source_record_id": source_record_id,
                    "label": properties.get("source_label")
                    or "Расчётное население проектной зоны",
                    "uri": properties.get("source_url"),
                },
                qualitative_confidence=_confidence(
                    properties.get("qualitative_confidence")
                ),
            )
        )
    # Ambiguous duplicate inputs must never be silently averaged or selected.
    return matches[0] if len(matches) == 1 else None


def _sum_rows(rows, horizon, multiplier):
    parts = []
    for row in rows:
        factor = _horizon_factor(row, horizon)
        scale = multiplier(row)
        if factor is not None and scale is not None:
            parts.append((row, row.value * factor * scale))
    units = {row.unit for row, _ in parts}
    if not parts or len(units) != 1:
        return None
    return (
        sum((value for _, value in parts), Decimal(0)),
        next(iter(units)),
        _unique_refs([row.source_ref for row, _ in parts]),
        {row.basis for row, _ in parts},
        _combined_confidence(row.qualitative_confidence for row, _ in parts),
    )


def ecosystem_metrics(db, revision):
    """Calculate only indicators supported by exact records frozen in the revision."""
    counts, density_missing = _placement_counts(db, revision)
    density_gap = (
        gap(
            "area_patch_density_missing",
            "Экологический расчёт требует плотность каждой площадной посадки",
            *density_missing,
        )
        if density_missing
        else None
    )
    version, rows = _profile_rows(db, revision)
    if version is None:
        return [
            _missing_metric(key, unit, horizon, density_gap)
            for horizon in HORIZONS
            for key, unit in METRICS
        ]
    status = "synthetic" if version.synthetic else "estimated"
    zone = db.get(ZoneVersion, revision.zone_version_id)
    zone_area = _decimal(zone.payload.get("area_m2")) if zone is not None else None
    population = _population_row(db, revision, zone)
    by_key = {key: [row for row in rows if row.metric_key == key] for key, _ in METRICS}
    computed = {}

    # Green area is the only admissible foundation for area-based flows and cooling.
    for horizon in HORIZONS:
        green = _sum_rows(
            by_key["green_area"],
            horizon,
            lambda row: counts.get(row.basis),
        )
        if green is not None and green[1] == "m2":
            computed[("green_area", horizon)] = green

    result = []
    for horizon in HORIZONS:
        green = computed.get(("green_area", horizon))
        for key, default_unit in METRICS:
            calculated = None
            if key == "green_area":
                calculated = green
            elif key == "green_area_per_person":
                if green is not None and population is not None:
                    calculated = (
                        green[0] / population.count,
                        "m2",
                        _unique_refs(green[2] + [population.source_ref]),
                        {"per_person"},
                        _combined_confidence(
                            [green[4], population.qualitative_confidence]
                        ),
                    )
            elif key == "air_cooling" and green is not None and zone_area and zone_area > 0:
                calculated = _sum_rows(
                    by_key[key],
                    horizon,
                    lambda _row, green_value=green[0]: green_value / zone_area,
                )
                if calculated is not None:
                    calculated = (
                        calculated[0],
                        calculated[1],
                        _unique_refs(calculated[2] + green[2]),
                        calculated[3],
                        _combined_confidence([calculated[4], green[4]]),
                    )
            elif key in FLOW_KEYS:

                def multiplier(row, green_value=green[0] if green is not None else None):
                    if row.basis == "per_green_m2_year":
                        return green_value
                    return counts.get(row.basis)

                calculated = _sum_rows(by_key[key], horizon, multiplier)
                if (
                    calculated is not None
                    and "per_green_m2_year" in calculated[3]
                    and green is not None
                ):
                    calculated = (
                        calculated[0],
                        calculated[1],
                        _unique_refs(calculated[2] + green[2]),
                        calculated[3],
                        _combined_confidence([calculated[4], green[4]]),
                    )
            if calculated is None:
                result.append(_missing_metric(key, default_unit, horizon, density_gap))
            else:
                value, unit, refs, _bases, confidence = calculated
                result.append(
                    _metric(key, unit, horizon, value, status, refs, confidence)
                )
    return result
