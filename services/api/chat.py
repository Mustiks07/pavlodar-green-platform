"""Authorized durable chat sessions and read-only grounded assistant context."""

import base64
import copy
import json
from datetime import UTC, datetime, timedelta
from uuid import UUID

from pydantic import ValidationError as PydanticValidationError
from sqlalchemy import select

from packages.domain.errors import DomainError
from packages.domain.generated import AppendRevisionInput
from packages.geo.geometry import zone_area
from services.api.llm import LLMReply, LLMRequest, Message, ToolSpec, Usage
from services.api.models import (
    CalculationSnapshotRecord,
    ChatMessageRecord,
    ChatSessionRecord,
    City,
    Job,
    Outbox,
    Principal,
    PriorityResultRecord,
    ProposalRecord,
    Scenario,
    ScenarioRevision,
    Zone,
    ZoneVersion,
)
from services.api.security import Access
from services.api.use_cases import authorized_revision, canonical_hash, found, now, uid
from services.worker.jobs import QUEUES, event

PROPOSAL_ARGUMENT_KEYS = {"summary", "placement_id", "quantity"}


def grounded_fallback_reply(request):
    """Return a bounded facts-only answer when every configured LLM is unavailable.

    This is deliberately not a second calculation engine and never creates proposals. It keeps
    the demonstration useful during a provider outage by summarising only AUTHORIZED_CONTEXT.
    """
    marker = "AUTHORIZED_CONTEXT="
    encoded = next(
        (message.content[len(marker) :] for message in request.messages if message.content.startswith(marker)),
        "{}",
    )
    try:
        context = json.loads(encoded)
    except (TypeError, json.JSONDecodeError):
        context = {}
    city = context.get("city") or {}
    lines = [
        f"Контекст платформы загружен: {city.get('name') or 'выбранный город'}.",
    ]
    zone = context.get("zone") or {}
    if zone:
        area = zone.get("area_m2")
        area_text = f"{area:,.0f}".replace(",", " ") if isinstance(area, (int, float)) else "—"
        lines.append(f"Участок: {area_text} м², назначение — {zone.get('purpose') or 'не указано'}.")
    calculation = context.get("latest_calculation") or {}
    if calculation:
        total = calculation.get("full_total_kzt")
        lines.append(
            f"Последний расчёт: статус {calculation.get('status') or 'не указан'}, "
            + (f"полная стоимость {total} ₸." if total is not None else "полная стоимость пока недоступна.")
        )
        available = [
            item
            for item in calculation.get("ecosystem", [])
            if item.get("value") is not None
        ]
        if available:
            item = available[0]
            lines.append(
                f"Экологический показатель: {item.get('key')} — {item.get('value')} "
                f"{item.get('unit')} на горизонте {item.get('horizon_year')} лет."
            )
    problems = context.get("problems") or []
    if problems:
        lines.append(
            "Открытые проблемы: "
            + "; ".join(
                f"{item.get('severity')}: {item.get('description')}"
                for item in problems[:3]
            )
            + "."
        )
    priority = context.get("priority") or {}
    zones = priority.get("zones") or []
    if zones:
        def display_score(value):
            if value is None:
                return "—"
            score = float(value)
            return round(score if score > 1 else score * 100)

        lines.append(
            "Первые зоны по приоритету: "
            + "; ".join(
                f"{item.get('zone_name') or item.get('zone_id')} — "
                f"{display_score(item.get('score'))}/100"
                for item in zones[:3]
            )
            + "."
        )
    lines.append(
        "Внешняя модель временно недоступна, поэтому ответ ограничен подтверждёнными фактами и не изменяет проект."
    )
    return LLMReply(
        provider="grounded-fallback",
        model="authorized-context-summary-v1",
        text="\n".join(lines),
        tool_calls=(),
        usage=Usage(input_tokens=None, output_tokens=None),
    )


def latest_calculation_context(snapshot_id, payload):
    """Expose bounded canonical results without reinterpreting missing values."""
    cost = payload.get("cost") or {}
    return {
        "id": snapshot_id,
        "status": payload.get("status"),
        "known_total_kzt": cost.get("known_subtotal"),
        "full_total_kzt": cost.get("total"),
        "cost_lines": [
            {
                key: item.get(key)
                for key in ("category", "quantity", "unit", "unit_price", "subtotal", "year")
            }
            for item in cost.get("lines", [])[:50]
        ],
        "cost_gap_codes": [item.get("code") for item in cost.get("data_gaps", [])[:50]],
        "survival": [
            {
                "placement_id": item.get("placement_id"),
                "model_kind": item.get("model_kind"),
                "calibration_status": item.get("calibration_status"),
                "points": item.get("points", [])[:3],
                "risks": item.get("risks", [])[:10],
                "data_gap_codes": [gap.get("code") for gap in item.get("data_gaps", [])[:10]],
            }
            for item in payload.get("survival", [])[:100]
        ],
        "care": [
            {
                key: item.get(key)
                for key in (
                    "month",
                    "year_offset",
                    "operation",
                    "quantity",
                    "unit",
                    "water_m3",
                    "crew_minutes",
                    "visits",
                )
            }
            for item in payload.get("care", [])[:60]
        ],
        "ecosystem": [
            {
                key: item.get(key)
                for key in (
                    "key",
                    "value",
                    "unit",
                    "horizon_year",
                    "status",
                    "lower",
                    "upper",
                    "qualitative_confidence",
                )
            }
            for item in payload.get("ecosystem", [])[:21]
        ],
        "warning_codes": [item.get("code") for item in payload.get("warnings", [])],
    }


def session_payload(value):
    return {
        "id": value.id,
        "city_id": value.city_id,
        "zone_id": value.zone_id,
        "scenario_revision_id": value.scenario_revision_id,
        "created_at": value.created_at.isoformat().replace("+00:00", "Z"),
    }


def message_payload(value):
    return {
        "id": value.id,
        "session_id": value.session_id,
        "role": value.role,
        "text": value.text,
        "state": value.state,
        "facts": value.facts,
        "proposal_id": value.proposal_id,
        "created_at": value.created_at.isoformat().replace("+00:00", "Z"),
    }


def session_access(db, access, session_id):
    value = found(db.get(ChatSessionRecord, session_id))
    access.city(value.city_id)
    if value.owner_id != access.user.id and access.level < 2:
        raise DomainError(404, "not_found", "Object not found")
    if value.zone_id:
        zone = found(db.get(Zone, value.zone_id))
        if zone.city_id != value.city_id:
            raise DomainError(500, "city_mismatch", "Chat zone city mismatch")
    if value.scenario_revision_id:
        revision = authorized_revision(db, access, value.scenario_revision_id)
        scenario = found(db.get(Scenario, revision.scenario_id))
        if scenario.city_id != value.city_id:
            raise DomainError(500, "city_mismatch", "Chat revision city mismatch")
    return value


def create_session(db, access, body):
    access.role("specialist")
    access.city(body["city_id"])
    if body["zone_id"]:
        zone = found(db.get(Zone, body["zone_id"]))
        if zone.city_id != body["city_id"]:
            raise DomainError(422, "city_mismatch", "Zone belongs to another city")
    if body["scenario_revision_id"]:
        revision = authorized_revision(db, access, body["scenario_revision_id"])
        scenario = found(db.get(Scenario, revision.scenario_id))
        if scenario.city_id != body["city_id"]:
            raise DomainError(422, "city_mismatch", "Scenario belongs to another city")
        if body["zone_id"] and scenario.zone_id != body["zone_id"]:
            raise DomainError(422, "city_mismatch", "Scenario belongs to another zone")
    value = ChatSessionRecord(
        id=uid(),
        city_id=body["city_id"],
        owner_id=access.user.id,
        zone_id=body["zone_id"],
        scenario_revision_id=body["scenario_revision_id"],
        created_at=datetime.now(UTC),
    )
    db.add(value)
    db.flush()
    return session_payload(value)


def list_messages(db, access, session_id, params):
    value = session_access(db, access, session_id)
    limit = int(params.get("limit", 50))
    context = canonical_hash(
        {"operation": "listChatMessages", "user": access.user.id, "session": value.id}
    )
    statement = select(ChatMessageRecord).where(ChatMessageRecord.session_id == value.id)
    if params.get("cursor"):
        try:
            cursor = json.loads(base64.urlsafe_b64decode(params["cursor"].encode()))
            after_time = datetime.fromisoformat(cursor["created_at"])
            after_id = str(UUID(cursor["id"]))
            if cursor["context"] != context:
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            raise DomainError(422, "invalid_cursor", "Cursor does not match this query") from None
        statement = statement.where(
            (ChatMessageRecord.created_at > after_time)
            | (
                (ChatMessageRecord.created_at == after_time)
                & (ChatMessageRecord.id > after_id)
            )
        )
    rows = list(
        db.scalars(
            statement.order_by(ChatMessageRecord.created_at, ChatMessageRecord.id).limit(limit + 1)
        )
    )
    next_cursor = None
    if len(rows) > limit:
        last = rows[limit - 1]
        next_cursor = base64.urlsafe_b64encode(
            json.dumps(
                {
                    "created_at": last.created_at.isoformat().replace("+00:00", "Z"),
                    "id": last.id,
                    "context": context,
                }
            ).encode()
        ).decode()
    return {"items": [message_payload(row) for row in rows[:limit]], "next_cursor": next_cursor}


def _selected_revision(db, access, chat_session, requested_revision_id):
    revision_id = requested_revision_id or chat_session.scenario_revision_id
    if not revision_id:
        return None
    revision = authorized_revision(db, access, revision_id)
    scenario = found(db.get(Scenario, revision.scenario_id))
    if scenario.city_id != chat_session.city_id:
        raise DomainError(422, "city_mismatch", "Scenario belongs to another city")
    if chat_session.zone_id and scenario.zone_id != chat_session.zone_id:
        raise DomainError(422, "city_mismatch", "Scenario belongs to another zone")
    if chat_session.scenario_revision_id:
        base = found(db.get(ScenarioRevision, chat_session.scenario_revision_id))
        if base.scenario_id != revision.scenario_id:
            raise DomainError(422, "city_mismatch", "Chat is bound to another scenario")
    return revision


def enqueue_message(db, access, session_id, body):
    access.role("specialist")
    chat_session = session_access(db, access, session_id)
    revision = _selected_revision(db, access, chat_session, body["scenario_revision_id"])
    user_message_id, assistant_message_id, job_id = uid(), uid(), uid()
    created = datetime.now(UTC)
    job_payload = {
        "id": job_id,
        "kind": "chat",
        "state": "queued",
        "phase": None,
        "progress": None,
        "input_ref_id": chat_session.id,
        "result_ref_id": None,
        "attempt": 0,
        "created_at": now(),
        "started_at": None,
        "completed_at": None,
        "error": None,
    }
    job = Job(
        id=job_id,
        owner_id=access.user.id,
        city_id=chat_session.city_id,
        input_revision_id=None,
        input_ref_id=chat_session.id,
        input_kind="chat_session",
        state="queued",
        attempt=0,
        request_payload={
            "user_message_id": user_message_id,
            "assistant_message_id": assistant_message_id,
            "scenario_revision_id": revision.id if revision else None,
        },
        payload=job_payload,
    )
    db.add(job)
    db.flush()
    db.add_all(
        [
            ChatMessageRecord(
                id=user_message_id,
                session_id=chat_session.id,
                job_id=None,
                role="user",
                state="completed",
                text=body["text"],
                facts=[],
                proposal_id=None,
                created_at=created,
            ),
            ChatMessageRecord(
                id=assistant_message_id,
                session_id=chat_session.id,
                job_id=job.id,
                role="assistant",
                state="queued",
                text="",
                facts=[],
                proposal_id=None,
                created_at=created + timedelta(microseconds=1),
            ),
        ]
    )
    db.add(Outbox(id=uid(), job_id=job.id, queue=QUEUES["chat"], created_at=created))
    event(db, job)
    return job.payload


def _facts_and_context(db, access, chat_session, revision_id):
    city = found(db.get(City, chat_session.city_id))
    city_name = city.payload.get("name") or "Павлодар"
    for suffix in (
        " — СИНТЕТИЧЕСКИЙ ТЕСТОВЫЙ КОНТУР",
        " — рабочий контур OSM",
    ):
        if city_name.endswith(suffix):
            city_name = city_name[: -len(suffix)]
    context = {
        "city": {
            "id": city.id,
            "name": city_name,
            "boundary_status": city.payload.get("boundary_status"),
            "synthetic": city.synthetic,
        }
    }
    facts = []
    from services.api.problems import list_problems

    problem_page = list_problems(
        db,
        access,
        {"city_id": city.id, "limit": 50, "cursor": None, "severity": None, "kind": None},
    )
    context["problems"] = [
        {
            key: item.get(key)
            for key in (
                "zone_id",
                "kind",
                "severity",
                "description",
                "recommendation",
                "status",
            )
        }
        for item in problem_page["items"]
        if item["status"] != "dismissed"
    ]
    priority_statement = select(PriorityResultRecord).where(
        PriorityResultRecord.city_id == city.id
    )
    if access.level < 2:
        priority_statement = priority_statement.where(
            PriorityResultRecord.actor_id == access.user.id
        )
    priority = db.scalar(
        priority_statement.order_by(
            PriorityResultRecord.created_at.desc(), PriorityResultRecord.id.desc()
        ).limit(1)
    )
    if priority:
        zone_names = {
            zone.id: db.get(ZoneVersion, zone.current_version_id).payload.get("name")
            for zone in db.scalars(
                select(Zone).where(Zone.id.in_([item["zone_id"] for item in priority.payload["zones"]]))
            )
        }
        context["priority"] = {
            "id": priority.id,
            "created_at": priority.payload["created_at"],
            "weights": priority.payload["weights"],
            "zones": [
                {**item, "zone_name": zone_names.get(item["zone_id"])}
                for item in priority.payload["zones"][:100]
            ],
        }
    if chat_session.zone_id:
        zone = found(db.get(Zone, chat_session.zone_id))
        version = found(db.get(ZoneVersion, zone.current_version_id))
        area = zone_area(version.payload["geometry"], city.payload["boundary"])
        context["zone"] = {
            "id": zone.id,
            "current_version_id": version.id,
            "area_m2": area,
            "purpose": version.payload.get("purpose"),
        }
        facts.append(
            {
                "id": uid(),
                "label": "Площадь участка",
                "metric": {
                    "key": "zone_area",
                    "value": area,
                    "unit": "m2",
                    "horizon_year": None,
                    "status": "synthetic" if version.synthetic else "estimated",
                    "lower": None,
                    "upper": None,
                    "qualitative_confidence": "medium",
                    "method_version": "utm43n-area-v1",
                    "source_refs": [],
                    "missing_reason": None,
                },
                "calculation_id": None,
                "scenario_revision_id": revision_id,
            }
        )
    if revision_id:
        revision = authorized_revision(db, access, revision_id)
        scenario = found(db.get(Scenario, revision.scenario_id))
        context["scenario"] = {
            "id": scenario.id,
            "revision_id": revision.id,
            "is_current": scenario.current_revision_id == revision.id,
            "status": scenario.status,
            "placement_count": len(revision.payload.get("placements", [])),
            "synthetic_inputs": bool(revision.payload.get("synthetic_inputs")),
            "placements": [
                {
                    "id": item["id"],
                    "plant_id": item["plant_id"],
                    "quantity": item["quantity"],
                    "locked": item["locked"],
                }
                for item in revision.payload.get("placements", [])[:100]
            ],
            "placements_truncated": len(revision.payload.get("placements", [])) > 100,
        }
        catalog_id = revision.payload.get("catalog_version_id")
        if catalog_id:
            from services.api.models import PlantVersion

            plants = list(
                db.scalars(
                    select(PlantVersion)
                    .where(PlantVersion.catalog_version_id == catalog_id)
                    .order_by(PlantVersion.plant_id)
                    .limit(100)
                )
            )
            context["catalog"] = {
                "version_id": catalog_id,
                "plants": [
                    {
                        "id": row.plant_id,
                        "name": row.payload["russian_name"],
                        "latin_name": row.payload["latin_name"],
                        "stratum": row.payload["stratum"],
                        "expert_status": row.payload["expert_status"],
                        "sensitive_site_status": row.payload["sensitive_site_status"],
                    }
                    for row in plants
                ],
                "truncated": len(plants) == 100,
            }
        snapshot = db.scalar(
            select(CalculationSnapshotRecord)
            .where(CalculationSnapshotRecord.scenario_revision_id == revision.id)
            .order_by(CalculationSnapshotRecord.created_at.desc(), CalculationSnapshotRecord.id.desc())
            .limit(1)
        )
        if snapshot:
            context["latest_calculation"] = latest_calculation_context(snapshot.id, snapshot.payload)
            for item in snapshot.payload.get("ecosystem", [])[:21]:
                if item.get("value") is None:
                    continue
                facts.append(
                    {
                        "id": uid(),
                        "label": f"{item['key']} · {item.get('horizon_year') or 'текущий горизонт'}",
                        "metric": item,
                        "calculation_id": snapshot.id,
                        "scenario_revision_id": revision.id,
                    }
                )
    return facts, context


def proposal_tool_available(revision_id, scenario_context):
    if not revision_id or not isinstance(scenario_context, dict):
        return False
    placements = scenario_context.get("placements")
    if not isinstance(placements, list):
        return False
    return (
        scenario_context.get("is_current") is True
        and scenario_context.get("status") == "draft"
        and any(
            isinstance(item, dict) and item.get("locked") is False
            for item in placements[:100]
        )
    )


def validate_quantity_proposal_arguments(arguments):
    if not isinstance(arguments, dict) or set(arguments) != PROPOSAL_ARGUMENT_KEYS:
        raise ValueError("shape")
    summary = arguments["summary"]
    quantity = arguments["quantity"]
    if not isinstance(summary, str) or not summary.strip() or len(summary.strip()) > 1000:
        raise ValueError("summary")
    if (
        not isinstance(quantity, int)
        or isinstance(quantity, bool)
        or not 1 <= quantity <= 100_000
    ):
        raise ValueError("quantity")
    try:
        placement_id = str(UUID(arguments["placement_id"]))
    except (ValueError, TypeError, AttributeError):
        raise ValueError("placement_id") from None
    return summary.strip(), placement_id, quantity


def prepare_chat_request(db, job):
    if not job.request_payload:
        raise DomainError(500, "job_input_invalid", "Chat request is missing")
    user = found(db.get(Principal, job.owner_id))
    access = Access(db, user, None)
    chat_session = session_access(db, access, job.input_ref_id)
    user_message = found(db.get(ChatMessageRecord, job.request_payload["user_message_id"]))
    if user_message.session_id != chat_session.id or user_message.role != "user":
        raise DomainError(500, "job_input_invalid", "Chat message does not match the job")
    facts, context = _facts_and_context(
        db, access, chat_session, job.request_payload.get("scenario_revision_id")
    )
    scenario_context = context.get("scenario") or {}
    can_propose = proposal_tool_available(
        job.request_payload.get("scenario_revision_id"), scenario_context
    )
    tools = (
        (
            ToolSpec(
                name="propose_placement_quantity",
                description=(
                    "Prepare, but never apply, one reviewable change to the quantity of an "
                    "existing unlocked placement from AUTHORIZED_CONTEXT."
                ),
                parameters={
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "summary": {"type": "string", "minLength": 1, "maxLength": 1000},
                        "placement_id": {"type": "string", "format": "uuid"},
                        "quantity": {"type": "integer", "minimum": 1, "maximum": 100000},
                    },
                    "required": ["summary", "placement_id", "quantity"],
                },
            ),
        )
        if can_propose
        else ()
    )
    system = (
        "Ты помощник платформы озеленения Павлодара. Отвечай по-русски и только по "
        "AUTHORIZED_CONTEXT. Не придумывай числа, официальность, выполненные действия или "
        "отсутствующие данные. Если значения нет, прямо скажи, что оно недоступно. "
        "Не предлагай обход прав и не выполняй изменения. Если доступен инструмент предложения, "
        "используй его только по явной просьбе пользователя изменить количество существующего "
        "незаблокированного размещения. Инструмент создаёт только черновик для проверки человеком."
    )
    return (
        LLMRequest(
            messages=(
                Message("system", system),
                Message(
                    "system",
                    "AUTHORIZED_CONTEXT="
                    + json.dumps(context, ensure_ascii=False, separators=(",", ":")),
                ),
                Message("user", user_message.text),
            ),
            tools=tools,
        ),
        facts,
    )


def _proposed_revision(db, access, job, reply, message):
    if not reply.tool_calls:
        return None, reply.text
    if len(reply.tool_calls) != 1 or reply.tool_calls[0].name != "propose_placement_quantity":
        raise DomainError(422, "invalid_body", "Assistant returned an unsupported proposal")
    try:
        summary, placement_id, quantity = validate_quantity_proposal_arguments(
            reply.tool_calls[0].arguments
        )
    except ValueError as error:
        raise DomainError(
            422, "invalid_body", f"Assistant proposal arguments are invalid: {error}"
        ) from None
    revision_id = job.request_payload.get("scenario_revision_id")
    if not revision_id:
        raise DomainError(422, "invalid_body", "Proposal requires a bound scenario revision")
    revision = authorized_revision(db, access, revision_id)
    scenario = found(
        db.scalar(select(Scenario).where(Scenario.id == revision.scenario_id).with_for_update())
    )
    if scenario.current_revision_id != revision.id or scenario.status != "draft":
        return None, "Сценарий изменился во время подготовки предложения. Перечитайте актуальную версию."
    proposed = copy.deepcopy(revision.payload)
    placements = proposed.get("placements", [])
    selected = next((item for item in placements if item.get("id") == placement_id), None)
    if selected is None or selected.get("locked") is not False:
        raise DomainError(422, "invalid_body", "Placement is unavailable for this proposal")
    selected["quantity"] = quantity
    proposed["parent_revision_id"] = revision.id
    for key in ("id", "scenario_id", "created_at", "input_hash", "synthetic_inputs"):
        proposed.pop(key, None)
    try:
        proposed = AppendRevisionInput.model_validate(proposed).model_dump(mode="json")
    except PydanticValidationError:
        raise DomainError(422, "invalid_body", "Assistant proposal is not a valid revision") from None
    created = datetime.now(UTC)
    value = ProposalRecord(
        id=uid(),
        scenario_id=scenario.id,
        base_revision_id=revision.id,
        owner_id=access.user.id,
        assistant_message_id=message.id,
        status="pending",
        summary=summary,
        proposed_revision=proposed,
        expires_at=created + timedelta(hours=24),
        created_at=created,
        decided_at=None,
        decision_reason=None,
    )
    db.add(value)
    db.flush()
    return value, reply.text or summary


def persist_chat_reply(db, job, reply, facts):
    user = found(db.get(Principal, job.owner_id))
    access = Access(db, user, None)
    chat_session = session_access(db, access, job.input_ref_id)
    message = found(db.get(ChatMessageRecord, job.request_payload["assistant_message_id"]))
    if message.session_id != chat_session.id or message.job_id != job.id:
        raise DomainError(500, "job_input_invalid", "Assistant message does not match the job")
    proposal, text = _proposed_revision(db, access, job, reply, message)
    message.text = text[:20_000]
    message.state = "completed"
    message.facts = facts
    message.provider = reply.provider
    message.model = reply.model
    message.input_tokens = reply.usage.input_tokens
    message.output_tokens = reply.usage.output_tokens
    message.proposal_id = proposal.id if proposal else None
    return message.id
