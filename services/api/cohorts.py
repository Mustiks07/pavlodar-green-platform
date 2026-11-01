"""Planting cohorts, immutable inspections and explicit replacement lineage."""

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import func, select

from packages.domain.errors import DomainError, gap
from services.api.models import (
    CohortRecord,
    Dataset,
    DatasetVersion,
    InspectionRecord,
    PlantIdentity,
    ScenarioRevision,
)
from services.api.work_orders import active_completions, get_work_order

FORECAST_OBSERVED_METHOD = "forecast_observed_v1_anniversary_30d"
MAX_COMPARABLE_DATE_OFFSET_DAYS = 30


def cohort_payload(cohort):
    return {
        "id": cohort.id,
        "city_id": cohort.city_id,
        "zone_id": cohort.zone_id,
        "plant_id": cohort.plant_id,
        "placement_id": cohort.placement_id,
        "initial_quantity": cohort.initial_quantity,
        "planting_date": cohort.planting_date.isoformat(),
        "replaces_cohort_id": cohort.replaces_cohort_id,
        "source_work_order_id": cohort.source_work_order_id,
        "latest_inspection_id": cohort.latest_inspection_id,
    }


def cohort_access(access, cohort):
    access.city(cohort.city_id)
    return cohort


def get_cohort(db, access, cohort_id, *, lock=False):
    statement = select(CohortRecord).where(CohortRecord.id == cohort_id)
    cohort = db.scalar(statement.with_for_update() if lock else statement)
    if cohort is None:
        raise DomainError(404, "not_found", "Object not found")
    return cohort_access(access, cohort)


def _placement(revision, placement_id=None, plant_id=None):
    candidates = revision.payload["placements"]
    if placement_id is not None:
        candidates = [item for item in candidates if item["id"] == placement_id]
    if plant_id is not None:
        candidates = [item for item in candidates if item["plant_id"] == plant_id]
    if len(candidates) != 1:
        raise DomainError(
            422,
            "cohort_placement_invalid",
            "Work order must resolve to exactly one scenario placement",
        )
    return candidates[0]


def _completed_piece_order(db, access, work_order_id, planting_date):
    order = get_work_order(db, access, work_order_id, lock=True)
    if order.status != "completed" or order.payload["unit"] != "piece":
        raise DomainError(
            422,
            "cohort_work_order_invalid",
            "Cohorts require a completed piece-based work order",
        )
    revision = db.get(ScenarioRevision, order.scenario_revision_id)
    if revision is None:
        raise DomainError(404, "not_found", "Object not found")
    rows = active_completions(db, order.id)
    performed_dates = {row.payload["performed_at"][:10] for row in rows}
    if planting_date not in performed_dates:
        raise DomainError(
            422,
            "cohort_planting_date_invalid",
            "Planting date must be supported by active completion evidence",
        )
    total = sum((Decimal(str(row.payload["quantity"])) for row in rows), Decimal(0))
    if total != total.to_integral_value() or total <= 0:
        raise DomainError(
            422,
            "cohort_quantity_invalid",
            "Planting evidence must resolve to a positive whole number of plants",
        )
    return order, revision, int(total)


def create_cohort(db, access, body, cohort_id):
    order, revision, quantity = _completed_piece_order(
        db, access, body["work_order_id"], body["planting_date"]
    )
    if db.scalar(
        select(CohortRecord).where(CohortRecord.source_work_order_id == order.id)
    ):
        raise DomainError(409, "cohort_work_order_used", "Work order already created a cohort")
    placement = _placement(revision, placement_id=body["placement_id"])
    if placement["quantity"] != quantity:
        raise DomainError(
            422,
            "cohort_quantity_invalid",
            "Completed quantity must equal the placement quantity",
        )
    if db.get(PlantIdentity, placement["plant_id"]) is None:
        raise DomainError(404, "not_found", "Object not found")
    cohort = CohortRecord(
        id=cohort_id,
        city_id=order.city_id,
        zone_id=order.zone_id,
        plant_id=placement["plant_id"],
        placement_id=placement["id"],
        initial_quantity=quantity,
        planting_date=date.fromisoformat(body["planting_date"]),
        replaces_cohort_id=None,
        source_work_order_id=order.id,
        latest_inspection_id=None,
    )
    db.add(cohort)
    return cohort_payload(cohort)


def create_inspection(db, access, body, inspection_id, created_at):
    cohort = get_cohort(db, access, body["cohort_id"], lock=True)
    if cohort.city_id != body["city_id"] or cohort.zone_id != body["zone_id"]:
        raise DomainError(422, "inspection_target_invalid", "Inspection target does not match")
    observed = body["alive_count"] + body["dead_count"] + body["unknown_count"]
    if observed < 1 or observed > cohort.initial_quantity:
        raise DomainError(
            422,
            "inspection_counts_invalid",
            "Observed counts must cover between one and the initial cohort quantity",
        )
    observed_at = datetime.fromisoformat(body["observed_at"])
    if observed_at.date() < cohort.planting_date:
        raise DomainError(
            422,
            "inspection_date_invalid",
            "Inspection cannot predate planting",
        )
    for source in body["source_refs"]:
        version = db.get(DatasetVersion, source["dataset_version_id"])
        if version is None:
            raise DomainError(404, "not_found", "Object not found")
        dataset = db.get(Dataset, version.dataset_id)
        if dataset is None:
            raise DomainError(404, "not_found", "Object not found")
        access.dataset(dataset)
        if version.status != "published" or dataset.city_id != cohort.city_id:
            raise DomainError(422, "inspection_source_invalid", "Inspection source is unavailable")
    payload = {"id": inspection_id, **body, "created_at": created_at}
    inspection = InspectionRecord(
        id=inspection_id,
        city_id=cohort.city_id,
        zone_id=cohort.zone_id,
        cohort_id=cohort.id,
        actor_id=access.user.id,
        observed_at=observed_at,
        payload=payload,
        created_at=datetime.fromisoformat(created_at),
    )
    db.add(inspection)
    current = db.get(InspectionRecord, cohort.latest_inspection_id) if cohort.latest_inspection_id else None
    if current is None or (inspection.observed_at, inspection.id) > (current.observed_at, current.id):
        cohort.latest_inspection_id = inspection.id
    return payload


def inspection_access(db, access, inspection):
    cohort = get_cohort(db, access, inspection.cohort_id)
    for source in inspection.payload["source_refs"]:
        version = db.get(DatasetVersion, source["dataset_version_id"])
        if version is None:
            raise DomainError(404, "not_found", "Object not found")
        dataset = db.get(Dataset, version.dataset_id)
        if dataset is None:
            raise DomainError(404, "not_found", "Object not found")
        access.dataset(dataset)
    return cohort


def create_replacement(db, access, body, cohort_id):
    original = get_cohort(db, access, body["original_cohort_id"], lock=True)
    latest = db.get(InspectionRecord, original.latest_inspection_id)
    if latest is None or latest.payload["dead_count"] < 1:
        raise DomainError(
            422,
            "replacement_evidence_missing",
            "A replacement requires deaths in the latest inspection",
        )
    order, revision, completed_quantity = _completed_piece_order(
        db, access, body["work_order_id"], body["planting_date"]
    )
    if order.city_id != original.city_id or order.zone_id != original.zone_id:
        raise DomainError(422, "replacement_target_invalid", "Replacement target does not match")
    if completed_quantity != body["quantity"]:
        raise DomainError(
            422,
            "cohort_quantity_invalid",
            "Replacement quantity must equal active completion evidence",
        )
    placement = _placement(revision, plant_id=body["plant_id"])
    if placement["quantity"] != body["quantity"]:
        raise DomainError(
            422,
            "cohort_quantity_invalid",
            "Replacement quantity must equal its placement quantity",
        )
    already_replaced = db.scalar(
        select(func.coalesce(func.sum(CohortRecord.initial_quantity), 0)).where(
            CohortRecord.replaces_cohort_id == original.id
        )
    )
    if already_replaced + body["quantity"] > latest.payload["dead_count"]:
        raise DomainError(
            422,
            "replacement_quantity_exceeded",
            "Replacement quantity exceeds deaths in the latest inspection",
        )
    if db.scalar(
        select(CohortRecord).where(CohortRecord.source_work_order_id == order.id)
    ):
        raise DomainError(409, "cohort_work_order_used", "Work order already created a cohort")
    cohort = CohortRecord(
        id=cohort_id,
        city_id=original.city_id,
        zone_id=original.zone_id,
        plant_id=body["plant_id"],
        placement_id=placement["id"],
        initial_quantity=body["quantity"],
        planting_date=date.fromisoformat(body["planting_date"]),
        replaces_cohort_id=original.id,
        source_work_order_id=order.id,
        latest_inspection_id=None,
    )
    db.add(cohort)
    return cohort_payload(cohort)


def _anniversary(planting_date, years):
    try:
        return planting_date.replace(year=planting_date.year + years)
    except ValueError:
        return planting_date.replace(year=planting_date.year + years, day=28)


def compare_forecast_observed(db, access, body):
    from services.api.calculations import authorized_snapshot

    cohort = get_cohort(db, access, body["cohort_id"])
    inspection = db.get(InspectionRecord, body["inspection_id"])
    if inspection is None or inspection.cohort_id != cohort.id:
        raise DomainError(404, "not_found", "Object not found")
    inspection_access(db, access, inspection)
    snapshot = authorized_snapshot(db, access, body["calculation_id"])
    order = get_work_order(db, access, cohort.source_work_order_id)
    if snapshot.scenario_revision_id != order.scenario_revision_id:
        raise DomainError(
            422,
            "comparison_lineage_mismatch",
            "Calculation and cohort must share the exact scenario revision",
        )

    horizon = body["horizon_year"]
    survival = next(
        (
            item
            for item in snapshot.payload["survival"]
            if item["placement_id"] == cohort.placement_id
        ),
        None,
    )
    point = (
        next((item for item in survival["points"] if item["year"] == horizon), None)
        if survival
        else None
    )
    probability = point["probability"] if point else None
    alive = inspection.payload["alive_count"]
    dead = inspection.payload["dead_count"]
    unknown = inspection.payload["unknown_count"]
    observed_total = alive + dead + unknown
    known_total = alive + dead
    coverage = Decimal(observed_total) / Decimal(cohort.initial_quantity)
    observed_probability = Decimal(alive) / Decimal(known_total) if known_total else None
    city_cohorts = list(
        db.scalars(
            select(CohortRecord).where(
                CohortRecord.city_id == cohort.city_id,
                CohortRecord.zone_id == cohort.zone_id,
            )
        )
    )
    children = {}
    for item in city_cohorts:
        if item.replaces_cohort_id:
            children.setdefault(item.replaces_cohort_id, []).append(item)
    replacements = []
    pending = list(children.get(cohort.id, []))
    seen = set()
    while pending:
        replacement = pending.pop()
        if replacement.id in seen:
            continue
        seen.add(replacement.id)
        replacements.append(replacement)
        pending.extend(children.get(replacement.id, []))
    replacements_planted = sum(item.initial_quantity for item in replacements)
    replacements_alive = 0
    replacements_complete = True
    for replacement in replacements:
        replacement_inspection = (
            db.get(InspectionRecord, replacement.latest_inspection_id)
            if replacement.latest_inspection_id
            else None
        )
        if replacement_inspection is None:
            replacements_complete = False
            break
        payload = replacement_inspection.payload
        replacement_observed = (
            payload["alive_count"] + payload["dead_count"] + payload["unknown_count"]
        )
        if replacement_observed != replacement.initial_quantity or payload["unknown_count"]:
            replacements_complete = False
            break
        replacements_alive += payload["alive_count"]
    if replacements and not replacements_complete:
        replacements_alive = None
    original_complete = observed_total == cohort.initial_quantity and unknown == 0
    total_alive = (
        alive + replacements_alive
        if original_complete and replacements_alive is not None
        else None
    )
    observed_date = inspection.observed_at.date()
    date_offset = abs((observed_date - _anniversary(cohort.planting_date, horizon)).days)
    gaps = []
    if snapshot.payload["status"] != "complete":
        gaps.append(
            gap(
                "comparison_snapshot_incomplete",
                "Forecast calculation is not complete",
                snapshot.id,
            )
        )
    if probability is None:
        gaps.append(
            gap(
                "comparison_forecast_unavailable",
                "Forecast survival probability is unavailable for this placement and horizon",
                cohort.placement_id,
                f"year:{horizon}",
            )
        )
    if coverage != Decimal(1):
        gaps.append(
            gap(
                "comparison_observation_coverage",
                "Inspection does not cover the full initial cohort",
                inspection.id,
            )
        )
    if unknown:
        gaps.append(
            gap(
                "comparison_observation_unknown",
                "Inspection contains plants with unknown outcome",
                inspection.id,
            )
        )
    if date_offset > MAX_COMPARABLE_DATE_OFFSET_DAYS:
        gaps.append(
            gap(
                "comparison_time_mismatch",
                "Inspection is outside the comparison window around the planting anniversary",
                inspection.id,
                f"year:{horizon}",
            )
        )
    if replacements and replacements_alive is None:
        replacement_gap = gap(
            "comparison_replacement_observation_incomplete",
            "Not every replacement cohort has a complete known-outcome inspection",
            *[item.id for item in replacements],
        )
        replacement_gap["blocking"] = False
        gaps.append(replacement_gap)
    comparable = not any(item["blocking"] for item in gaps) and observed_probability is not None
    forecast_decimal = Decimal(str(probability)) if probability is not None else None
    expected_alive = (
        forecast_decimal * Decimal(cohort.initial_quantity)
        if forecast_decimal is not None
        else None
    )
    delta = (
        observed_probability - forecast_decimal
        if comparable and forecast_decimal is not None
        else None
    )

    def number(value):
        return float(value.quantize(Decimal("0.000001"))) if value is not None else None

    return {
        "cohort_id": cohort.id,
        "placement_id": cohort.placement_id,
        "calculation_id": snapshot.id,
        "inspection_id": inspection.id,
        "horizon_year": horizon,
        "method_version": FORECAST_OBSERVED_METHOD,
        "date_offset_days": date_offset,
        "forecast_probability": number(forecast_decimal),
        "forecast_expected_alive": number(expected_alive),
        "observed_survival_probability": number(observed_probability),
        "initial_quantity": cohort.initial_quantity,
        "observed_alive_initial": alive,
        "replacement_cohort_count": len(replacements),
        "replacements_planted": replacements_planted,
        "replacements_alive": replacements_alive,
        "total_alive": total_alive,
        "observed_alive": alive,
        "observed_dead": dead,
        "observed_unknown": unknown,
        "observation_coverage": number(coverage),
        "probability_delta": number(delta),
        "comparable": comparable,
        "data_gaps": gaps,
    }
