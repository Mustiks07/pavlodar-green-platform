"""Authorized work-order workflow with append-only completion corrections."""

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import select

from packages.domain.errors import DomainError
from services.api.models import (
    Principal,
    Scenario,
    WorkCompletionRecord,
    WorkOrderRecord,
    WorkOrderStatusEvent,
    Zone,
    ZoneVersion,
)

WORK_CALENDAR_LIMIT = 5000


def work_order_statement(city_id, filters):
    """Build the canonical work-calendar filter before authorization/pagination/export."""
    planned_from = filters.get("planned_from")
    planned_to = filters.get("planned_to")
    if planned_from and planned_to and planned_from > planned_to:
        raise DomainError(
            422,
            "invalid_parameter",
            "planned_from must not be after planned_to",
            field_errors=[
                {
                    "path": "/planned_to",
                    "code": "date_range_invalid",
                    "message": "Конец периода не может быть раньше начала",
                }
            ],
        )
    statement = select(WorkOrderRecord).where(WorkOrderRecord.city_id == city_id)
    if filters.get("zone_id"):
        statement = statement.where(WorkOrderRecord.zone_id == filters["zone_id"])
    if filters.get("status"):
        statement = statement.where(WorkOrderRecord.status == filters["status"])
    if filters.get("operation"):
        statement = statement.where(
            WorkOrderRecord.payload["operation"].astext.ilike(
                f"%{filters['operation'].strip()}%"
            )
        )
    if filters.get("assignee_group"):
        statement = statement.where(
            WorkOrderRecord.payload["assignee_group"].astext.ilike(
                f"%{filters['assignee_group'].strip()}%"
            )
        )
    if planned_from:
        statement = statement.where(
            WorkOrderRecord.payload["planned_end"].astext >= planned_from
        )
    if planned_to:
        statement = statement.where(
            WorkOrderRecord.payload["planned_start"].astext <= planned_to
        )
    return statement


def freeze_work_calendar(db, access, city_id, filters, captured_at):
    """Freeze an authorized calendar snapshot for deterministic background export."""
    access.role("specialist")
    access.city(city_id)
    rows = list(
        db.scalars(
            work_order_statement(city_id, filters)
            .order_by(WorkOrderRecord.updated_at, WorkOrderRecord.id)
            .limit(WORK_CALENDAR_LIMIT + 1)
        )
    )
    if len(rows) > WORK_CALENDAR_LIMIT:
        raise DomainError(
            422,
            "work_calendar_export_limit",
            f"Work calendar export exceeds {WORK_CALENDAR_LIMIT} rows; narrow the filters",
        )
    order_ids = [row.id for row in rows]
    zone_ids = {row.zone_id for row in rows}
    zone_rows = list(db.scalars(select(Zone).where(Zone.id.in_(zone_ids)))) if zone_ids else []
    zone_versions = {
        row.id: row
        for row in db.scalars(
            select(ZoneVersion).where(
                ZoneVersion.id.in_([zone.current_version_id for zone in zone_rows])
            )
        )
    } if zone_rows else {}
    zones = {
        zone.id: zone_versions[zone.current_version_id].payload.get("name", zone.id)
        for zone in zone_rows
        if zone.current_version_id in zone_versions
    }
    completions = list(
        db.scalars(
            select(WorkCompletionRecord)
            .where(WorkCompletionRecord.work_order_id.in_(order_ids))
            .order_by(WorkCompletionRecord.created_at, WorkCompletionRecord.id)
        )
    ) if order_ids else []
    events = list(
        db.scalars(
            select(WorkOrderStatusEvent)
            .where(WorkOrderStatusEvent.work_order_id.in_(order_ids))
            .order_by(WorkOrderStatusEvent.created_at, WorkOrderStatusEvent.id)
        )
    ) if order_ids else []
    actor_ids = {row.actor_id for row in completions + events}
    actors = {
        row.id: row.display_name
        for row in db.scalars(select(Principal).where(Principal.id.in_(actor_ids)))
    } if actor_ids else {}
    corrected_ids = {row.correction_of_id for row in completions if row.correction_of_id}
    return {
        "captured_at": captured_at,
        "filters": {key: value for key, value in filters.items() if value not in (None, "")},
        "orders": [
            {**row.payload, "zone_name": zones.get(row.zone_id, row.zone_id)} for row in rows
        ],
        "completions": [
            {
                **row.payload,
                "id": row.id,
                "actor_name": actors.get(row.actor_id, row.actor_id),
                "active": row.id not in corrected_ids,
            }
            for row in completions
        ],
        "history": [
            {
                **row.payload,
                "id": row.id,
                "actor_name": actors.get(row.actor_id, row.actor_id),
            }
            for row in events
        ],
    }


def work_order_access(access, order):
    access.city(order.city_id)
    if access.level < 1 and order.status != "completed":
        raise DomainError(404, "not_found", "Object not found")
    return order


def get_work_order(db, access, order_id, *, lock=False):
    statement = select(WorkOrderRecord).where(WorkOrderRecord.id == order_id)
    order = db.scalar(statement.with_for_update() if lock else statement)
    if order is None:
        raise DomainError(404, "not_found", "Object not found")
    return work_order_access(access, order)


def validate_work_order_target(db, access, body, authorized_revision):
    revision = authorized_revision(db, access, body["scenario_revision_id"])
    scenario = db.get(Scenario, revision.scenario_id)
    zone = db.get(Zone, body["zone_id"])
    if (
        scenario is None
        or zone is None
        or scenario.city_id != body["city_id"]
        or scenario.zone_id != body["zone_id"]
        or zone.city_id != body["city_id"]
    ):
        raise DomainError(
            422,
            "work_order_target_invalid",
            "Scenario revision, zone and city must describe the same target",
        )
    if body["planned_end"] < body["planned_start"]:
        raise DomainError(
            422,
            "work_order_target_invalid",
            "Planned end must not be earlier than planned start",
        )
    care_operation_id = body.get("care_operation_id")
    if not care_operation_id:
        return revision, scenario, None, None
    operation = next(
        (
            item
            for item in revision.payload["custom_care_operations"]
            if item["id"] == care_operation_id
        ),
        None,
    )
    if operation is None:
        raise DomainError(
            422,
            "work_care_operation_invalid",
            "Care work order must reference a frozen care operation",
        )
    if (
        body["operation"] != operation["operation"]
        or Decimal(str(body["quantity"])) != Decimal(str(operation["quantity"]))
        or body["unit"] != operation["unit"]
    ):
        raise DomainError(
            422,
            "work_care_operation_invalid",
            "Work order operation, quantity and unit must match the frozen care operation",
        )
    placements = {
        item["id"]: item for item in revision.payload["placements"]
    }
    planting_years = {
        date.fromisoformat(placements[placement_id]["planting_date"]).year
        for placement_id in operation["placement_ids"]
        if placement_id in placements
    }
    if len(planting_years) != 1:
        raise DomainError(
            422,
            "work_calendar_ambiguous",
            "Care operation placements must share one planting year",
        )
    expected_year = next(iter(planting_years)) + operation["year_offset"]
    planned_start = date.fromisoformat(body["planned_start"])
    planned_end = date.fromisoformat(body["planned_end"])
    if (
        planned_start.year != expected_year
        or planned_end.year != expected_year
        or planned_start.month != operation["month"]
        or planned_end.month != operation["month"]
    ):
        raise DomainError(
            422,
            "work_calendar_mismatch",
            "Work order dates must match the frozen care month and year offset",
        )
    period = f"year:{operation['year_offset']}"
    if not any(item["period"] == period for item in revision.payload["resource_limits"]):
        raise DomainError(
            422,
            "work_resource_limit_missing",
            "Care execution requires an explicit resource limit for its period",
        )
    if db.scalar(
        select(WorkOrderRecord).where(
            WorkOrderRecord.scenario_revision_id == revision.id,
            WorkOrderRecord.care_operation_id == care_operation_id,
        )
    ):
        raise DomainError(
            409,
            "work_care_operation_used",
            "Frozen care operation already has a work order",
        )
    return revision, scenario, operation, period


def require_executable_scenario(db, order):
    from services.api.models import ScenarioRevision

    revision = db.get(ScenarioRevision, order.scenario_revision_id)
    scenario = db.get(Scenario, revision.scenario_id) if revision else None
    if (
        scenario is None
        or scenario.status != "approved"
        or scenario.current_revision_id != order.scenario_revision_id
    ):
        raise DomainError(
            422,
            "work_order_execution_blocked",
            "Execution requires the current revision of an approved scenario",
        )


def transition_work_order(db, access, order, target, reason, event_id, occurred_at):
    permitted = {
        "planned": {"assigned", "cancelled"},
        "assigned": {"planned", "in_progress", "cancelled"},
        "in_progress": {"assigned", "completed", "cancelled"},
        "completed": {"in_progress"},
        "cancelled": set(),
    }
    if target not in permitted[order.status]:
        raise DomainError(409, "work_order_transition_invalid", "Work-order transition is invalid")
    if target in {"assigned", "in_progress", "completed"}:
        require_executable_scenario(db, order)
    if target == "completed" and Decimal(str(order.payload["completed_quantity"])) != Decimal(
        str(order.payload["quantity"])
    ):
        raise DomainError(
            422,
            "work_order_execution_blocked",
            "Completed quantity must equal the planned quantity",
        )
    previous = order.status
    order.status = target
    order.updated_at = datetime.fromisoformat(occurred_at)
    order.payload = {**order.payload, "status": target, "updated_at": occurred_at}
    event = {
        "id": event_id,
        "work_order_id": order.id,
        "actor_id": access.user.id,
        "from_status": previous,
        "to_status": target,
        "reason": reason,
        "created_at": occurred_at,
    }
    db.add(
        WorkOrderStatusEvent(
            id=event_id,
            work_order_id=order.id,
            actor_id=access.user.id,
            payload=event,
            created_at=datetime.fromisoformat(occurred_at),
        )
    )
    return order.payload


def record_completion(db, access, order, body, completion_id, created_at):
    if order.status != "in_progress":
        raise DomainError(
            409,
            "work_order_transition_invalid",
            "Completions require an in-progress work order",
        )
    require_executable_scenario(db, order)
    if order.care_operation_id:
        performed = datetime.fromisoformat(body["performed_at"]).date()
        if not (
            date.fromisoformat(order.payload["planned_start"])
            <= performed
            <= date.fromisoformat(order.payload["planned_end"])
        ):
            raise DomainError(
                422,
                "work_calendar_mismatch",
                "Care completion must fall inside the planned calendar window",
            )
    correction_id = body.get("correction_of_id")
    if correction_id:
        corrected = db.get(WorkCompletionRecord, correction_id)
        if corrected is None or corrected.work_order_id != order.id:
            raise DomainError(404, "not_found", "Object not found")
        existing = db.scalar(
            select(WorkCompletionRecord).where(
                WorkCompletionRecord.correction_of_id == correction_id
            )
        )
        if existing:
            raise DomainError(
                409,
                "work_completion_already_corrected",
                "A completion can be corrected only once; correct the latest row instead",
            )
    payload = {
        "id": completion_id,
        "work_order_id": order.id,
        **body,
        "created_at": created_at,
    }
    completion = WorkCompletionRecord(
        id=completion_id,
        work_order_id=order.id,
        correction_of_id=correction_id,
        actor_id=access.user.id,
        payload=payload,
        created_at=datetime.fromisoformat(created_at),
    )
    db.add(completion)
    db.flush()
    rows = list(
        db.scalars(
            select(WorkCompletionRecord).where(WorkCompletionRecord.work_order_id == order.id)
        )
    )
    corrected_ids = {row.correction_of_id for row in rows if row.correction_of_id}
    total = sum(
        (Decimal(str(row.payload["quantity"])) for row in rows if row.id not in corrected_ids),
        Decimal(0),
    )
    planned = Decimal(str(order.payload["quantity"]))
    if total > planned:
        raise DomainError(
            422,
            "work_order_quantity_exceeded",
            "Active completion quantity exceeds the planned quantity",
        )
    order.payload = {
        **order.payload,
        "completed_quantity": float(total),
        "updated_at": created_at,
    }
    order.updated_at = datetime.fromisoformat(created_at)
    if order.care_operation_id:
        validate_actual_resources(db, order)
    return payload


def active_completions(db, order_id):
    rows = list(
        db.scalars(
            select(WorkCompletionRecord).where(WorkCompletionRecord.work_order_id == order_id)
        )
    )
    corrected_ids = {row.correction_of_id for row in rows if row.correction_of_id}
    return [row for row in rows if row.id not in corrected_ids]


def validate_actual_resources(db, order):
    from services.api.models import ScenarioRevision

    revision = db.get(ScenarioRevision, order.scenario_revision_id)
    limit = next(
        (
            item
            for item in revision.payload["resource_limits"]
            if item["period"] == order.resource_period
        ),
        None,
    )
    if limit is None:
        raise DomainError(
            422,
            "work_resource_limit_missing",
            "Care execution requires an explicit resource limit for its period",
        )
    orders = list(
        db.scalars(
            select(WorkOrderRecord).where(
                WorkOrderRecord.scenario_revision_id == order.scenario_revision_id,
                WorkOrderRecord.resource_period == order.resource_period,
                WorkOrderRecord.care_operation_id.is_not(None),
            )
        )
    )
    completions = [row for item in orders for row in active_completions(db, item.id)]
    checks = [
        ("water_m3", "water_m3", Decimal),
        ("crew_minutes", "crew_minutes", int),
        ("care_budget", "actual_care_cost", Decimal),
    ]
    for limit_key, evidence_key, cast in checks:
        maximum = limit[limit_key]
        if maximum is None:
            continue
        values = [row.payload.get(evidence_key) for row in completions]
        if any(value is None for value in values):
            raise DomainError(
                422,
                "work_resource_evidence_missing",
                f"Every care completion must record {evidence_key}",
            )
        used = sum((cast(str(value)) for value in values), cast(0))
        allowed = cast(str(maximum))
        if used > allowed:
            raise DomainError(
                422,
                "work_resource_exceeded",
                f"Actual {limit_key} exceeds {order.resource_period} limit",
            )
    if limit["max_visits"] is not None and len(completions) > limit["max_visits"]:
        raise DomainError(
            422,
            "work_resource_exceeded",
            f"Actual visits exceed {order.resource_period} limit",
        )
