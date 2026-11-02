"""Authorized durable chat sessions and read-only grounded assistant context."""

import base64
import copy
import json
import re
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from uuid import UUID

from pydantic import ValidationError as PydanticValidationError
from sqlalchemy import select

from packages.domain.errors import DomainError
from packages.domain.generated import AppendRevisionInput
from packages.geo.geometry import zone_area
from services.api.llm import LLMReply, LLMRequest, Message, ToolCall, ToolSpec, Usage
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
PLANT_PROPOSAL_ARGUMENT_KEYS = {"selection_mode"}
RECOMMEND_ARGUMENT_KEYS = {"top_n"}
RECOMMENDATION_WEIGHTS = (
    {"factor": "hardiness_fit", "weight": 3},
    {"factor": "moisture_fit", "weight": 3},
    {"factor": "salt_fit", "weight": 2},
    {"factor": "wind_fit", "weight": 2},
    {"factor": "light_fit", "weight": 1},
)
UUID_IN_TEXT = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b", re.IGNORECASE)
RAW_CONTEXT_MARKERS = (
    "AUTHORIZED_CONTEXT",
    "latest_calculation",
    "survival",
    "probability",
    "placement",
    "source_refs",
    "_id",
)
NUMERIC_CLAIM = re.compile(
    r"(?<![\w-])(?:\d{1,3}(?:[\s\u00a0]\d{3})+|\d+)(?:[.,]\d+)?\s*%?"
)


def server_owned_tool_reply(request):
    """Route explicit deterministic read-only actions before contacting an external model."""
    question = next(
        (message.content.lower() for message in reversed(request.messages) if message.role == "user"),
        "",
    )
    recommend_tool = next(
        (tool for tool in request.tools if tool.name == "recommend_plants"),
        None,
    )
    calculation_tool = next(
        (tool for tool in request.tools if tool.name == "calculate_current_scenario"),
        None,
    )
    plant_proposal_tool = next(
        (tool for tool in request.tools if tool.name == "propose_placement_plant"),
        None,
    )
    asks_recommendation = any(
        phrase in question
        for phrase in (
            "подбери раст",
            "подобрать раст",
            "рекомендуй раст",
            "порекомендуй раст",
            "какие растения посад",
            "какие виды посад",
        )
    )
    asks_plant_proposal = any(
        phrase in question
        for phrase in (
            "подготовь замену растения",
            "замени растение на лучший",
            "примени лучший вид",
            "лучший вид в проект",
            "лучшее растение в проект",
        )
    )
    asks_calculation = any(
        phrase in question
        for phrase in (
            "пересчитай проект",
            "пересчитай текущий проект",
            "рассчитай текущий проект",
            "выполни расчёт проекта",
            "выполни расчет проекта",
            "запусти расчёт проекта",
            "запусти расчет проекта",
        )
    )
    if calculation_tool and asks_calculation:
        return LLMReply(
            provider="server-tools",
            model="canonical-fast-calculation-v1",
            text="Запускаю проверочный расчёт текущей версии проекта.",
            tool_calls=(
                ToolCall(
                    "server-fast-calculation",
                    "calculate_current_scenario",
                    {},
                ),
            ),
            usage=Usage(input_tokens=None, output_tokens=None),
        )
    if plant_proposal_tool and asks_plant_proposal:
        return LLMReply(
            provider="server-tools",
            model="catalog-rule-recommendation-v1",
            text="Готовлю проверяемую замену вида. Проект изменится только после вашего подтверждения.",
            tool_calls=(
                ToolCall(
                    "server-plant-proposal",
                    "propose_placement_plant",
                    {"selection_mode": "best_for_first_unlocked"},
                ),
            ),
            usage=Usage(input_tokens=None, output_tokens=None),
        )
    if not recommend_tool or not asks_recommendation:
        return None
    return LLMReply(
        provider="server-tools",
        model="catalog-rule-recommendation-v1",
        text="Подбираю растения по закреплённому каталогу и правилам участка.",
        tool_calls=(ToolCall("server-recommendation", "recommend_plants", {"top_n": 5}),),
        usage=Usage(input_tokens=None, output_tokens=None),
    )


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
    question = next(
        (message.content.lower() for message in reversed(request.messages) if message.role == "user"),
        "",
    )
    tool_reply = server_owned_tool_reply(request)
    if tool_reply:
        return tool_reply
    asks_area = any(word in question for word in ("площад", "размер", "участ"))
    asks_cost = any(word in question for word in ("стоим", "смет", "бюджет", "цен"))
    asks_survival = any(word in question for word in ("прижив", "выжив", "сохранност"))
    asks_effect = any(word in question for word in ("эффект", "эколог", "co2", "тень", "вод"))
    asks_priority = any(word in question for word in ("приоритет", "проблем", "вниман", "территор"))
    general = not any((asks_area, asks_cost, asks_survival, asks_effect, asks_priority))
    lines = [
        f"Контекст платформы загружен: {city.get('name') or 'выбранный город'}.",
    ]
    zone = context.get("zone") or {}
    if zone and (general or asks_area):
        area = zone.get("area_m2")
        area_text = f"{area:,.0f}".replace(",", " ") if isinstance(area, (int, float)) else "—"
        lines.append(f"Участок: {area_text} м², назначение — {zone.get('purpose') or 'не указано'}.")
    calculation = context.get("latest_calculation") or {}
    if calculation:
        if general or asks_cost:
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
        if available and (general or asks_effect):
            item = available[0]
            lines.append(
                f"Экологический показатель: {item.get('key')} — {item.get('value')} "
                f"{item.get('unit')} на горизонте {item.get('horizon_year')} лет."
            )
        first_year = [
            point.get("probability")
            for result in calculation.get("survival", [])
            for point in result.get("points", [])
            if point.get("year") == 1 and isinstance(point.get("probability"), (int, float))
        ]
        if first_year and (general or asks_survival):
            percentages = [round(value * 100) for value in first_year]
            if len(set(percentages)) == 1:
                lines.append(
                    f"Расчётная приживаемость через 1 год — {percentages[0]}% "
                    f"для {len(percentages)} групп посадок."
                )
            else:
                lines.append(
                    "Расчётная приживаемость через 1 год по группам — "
                    + ", ".join(f"{value}%" for value in percentages)
                    + "."
                )
    problems = context.get("problems") or []
    if problems and (general or asks_priority):
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
    if zones and (general or asks_priority):
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


def _numeric_value(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        return Decimal(str(value).replace("\u00a0", "").replace(" ", "").replace(",", "."))
    except (InvalidOperation, ValueError):
        return None


def _claim_unit(text, match):
    if "%" in match.group():
        return "%"
    tail = text[match.end() : match.end() + 24].lstrip().lower()
    if re.match(r"^[–—-]\s*\d+(?:[.,]\d+)?\s*%", tail):
        return "%"
    aliases = (
        (r"^(?:₸|kzt\b|тг\b|тенге\b)", "KZT"),
        (r"^(?:м²|м2\b|m2\b)", "m2"),
        (r"^(?:м³|м3\b|m3\b)", "m3"),
        (r"^(?:кг\s*co2e|kg\s*co2e)", "kgCO2e"),
        (r"^(?:кг\b|kg\b)", "kg"),
        (r"^(?:год(?:а|ов)?\b|лет\b)", "year"),
        (r"^/\s*100", "score_100"),
        (r"^(?:групп(?:а|ы)?\b|объект(?:а|ов)?\b|шт\.?\b|штук(?:а|и)?\b)", "count"),
    )
    for pattern, unit in aliases:
        if re.match(pattern, tail, re.IGNORECASE):
            return unit
    # A word immediately after a number is an asserted but unknown unit/type, not harmless prose.
    if re.match(r"^[a-zа-яёµ°]", tail, re.IGNORECASE):
        return "unsupported"
    return None


def _numeric_claims(text):
    """Extract actual numeric claims while ignoring numbered-list markers."""
    claims = []
    for match in NUMERIC_CLAIM.finditer(text):
        line_start = text.rfind("\n", 0, match.start()) + 1
        prefix = text[line_start : match.start()]
        suffix = text[match.end() : match.end() + 1]
        if not prefix.strip() and suffix in {".", ")"}:
            continue
        value = _numeric_value(match.group().rstrip("% "))
        if value is not None:
            claims.append((value, _claim_unit(text, match)))
    return claims


def _supported_numeric_values(facts):
    plain = set()
    by_unit = {"%": set(), "year": set(), "count": set()}
    metric_counts = {}
    for fact in facts or ():
        metric = fact.get("metric") or {}
        key = metric.get("key")
        if key:
            metric_counts[key] = metric_counts.get(key, 0) + 1
        for field in ("value", "lower", "upper", "horizon_year"):
            value = _numeric_value(metric.get(field))
            if value is None:
                continue
            plain.add(value)
            plain.add(value.quantize(Decimal(1)))
            if field == "horizon_year":
                by_unit["year"].update((value, value.quantize(Decimal(1))))
            elif field in {"value", "lower", "upper"}:
                unit = metric.get("unit")
                if unit:
                    by_unit.setdefault(unit, set()).update((value, value.quantize(Decimal(1))))
            if field in {"value", "lower", "upper"} and metric.get("unit") == "1":
                percentage = value * 100
                by_unit["%"].add(percentage)
                by_unit["%"].add(percentage.quantize(Decimal(1)))
        if metric.get("unit") == "score_100":
            plain.add(Decimal(100))
    counts = {Decimal(count) for count in metric_counts.values()}
    plain.update(counts)
    by_unit["count"].update(counts)
    plain.add(Decimal(len(facts or ())))
    by_unit["count"].add(Decimal(len(facts or ())))
    return plain, by_unit


def numeric_claims_are_grounded(text, facts):
    """Require every provider-authored number to exist in a server Fact card."""
    claims = _numeric_claims(text)
    if not claims:
        return True
    plain, by_unit = _supported_numeric_values(facts)
    return all(
        value in plain if unit is None else value in by_unit.get(unit, set())
        for value, unit in claims
    )


def presentable_reply(request, reply, facts=()):
    """Replace raw or numerically unsupported provider text with a bounded server summary."""
    if reply.tool_calls:
        quantities = [
            call.arguments.get("quantity")
            for call in reply.tool_calls
            if isinstance(call.arguments, dict)
            and isinstance(call.arguments.get("quantity"), int)
            and not isinstance(call.arguments.get("quantity"), bool)
        ]
        plain, by_unit = _supported_numeric_values(facts)
        plain.update(Decimal(value) for value in quantities)
        by_unit["count"].update(Decimal(value) for value in quantities)
        text = reply.text.strip()
        claims = _numeric_claims(text)
        safe = (
            text
            and not UUID_IN_TEXT.search(text)
            and not any(marker in text for marker in RAW_CONTEXT_MARKERS)
            and all(
                value in plain if unit is None else value in by_unit.get(unit, set())
                for value, unit in claims
            )
        )
        if safe:
            return reply
        return LLMReply(
            provider=reply.provider,
            model=reply.model,
            text=(
                "Выполняю серверный подбор растений для текущего участка."
                if reply.tool_calls[0].name == "recommend_plants"
                else "Подготовлено предложение для проверки. Изменение ещё не применено."
            ),
            tool_calls=reply.tool_calls,
            usage=reply.usage,
        )
    text = reply.text.strip()
    raw = (
        not text
        or UUID_IN_TEXT.search(text)
        or any(marker in text for marker in RAW_CONTEXT_MARKERS)
        or not numeric_claims_are_grounded(text, facts)
    )
    if not raw:
        return reply
    fallback = grounded_fallback_reply(request)
    text = fallback.text.replace(
        "Внешняя модель временно недоступна, поэтому ответ ограничен подтверждёнными фактами и не изменяет проект.",
        "Ответ приведён к проверяемым фактам платформы и не изменяет проект.",
    )
    return LLMReply(
        provider=reply.provider,
        model=reply.model,
        text=text,
        tool_calls=(),
        usage=reply.usage,
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


def snapshot_facts(snapshot_id, revision_id, payload):
    """Return exact persisted metrics the UI can trace back to one immutable calculation.

    This deliberately does not aggregate or reinterpret groups. Each displayed probability is a
    value already stored by the survival module, with its interval and input references intact.
    """
    facts = []
    cost = payload.get("cost") or {}
    if cost.get("total") is not None:
        facts.append(
            {
                "id": uid(),
                "label": "Полная стоимость сценария",
                "metric": {
                    "key": "full_cost",
                    "value": float(Decimal(cost["total"])),
                    "unit": "KZT",
                    "horizon_year": None,
                    "status": "estimated",
                    "lower": None,
                    "upper": None,
                    "qualitative_confidence": "medium",
                    "method_version": "canonical-cost-v1",
                    "source_refs": [],
                    "missing_reason": None,
                },
                "calculation_id": snapshot_id,
                "scenario_revision_id": revision_id,
            }
        )
    for index, result in enumerate(payload.get("survival", [])[:5], start=1):
        point = next(
            (
                item
                for item in result.get("points", [])
                if item.get("year") == 1 and item.get("probability") is not None
            ),
            None,
        )
        if point is None:
            continue
        refs, seen = [], set()
        for risk in result.get("risks", []):
            for ref in risk.get("source_refs", []):
                key = (ref.get("dataset_version_id"), ref.get("source_record_id"))
                if key not in seen:
                    seen.add(key)
                    refs.append(ref)
        facts.append(
            {
                "id": uid(),
                "label": f"Приживаемость группы посадок {index} через 1 год",
                "metric": {
                    "key": "survival_probability",
                    "value": point["probability"],
                    "unit": "1",
                    "horizon_year": 1,
                    "status": "estimated",
                    "lower": point.get("lower"),
                    "upper": point.get("upper"),
                    "qualitative_confidence": "unknown",
                    "method_version": (
                        f"survival-{result.get('model_kind') or 'unknown'}-"
                        f"{result.get('calibration_status') or 'unknown'}"
                    ),
                    "source_refs": refs,
                    "missing_reason": None,
                },
                "calculation_id": snapshot_id,
                "scenario_revision_id": revision_id,
            }
        )
    return facts


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
        city_name = city_name.removesuffix(suffix)
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
        for item in priority.payload["zones"][:3]:
            if item.get("score") is None:
                continue
            refs = {}
            for contribution in item.get("contributions", []):
                for ref in contribution.get("source_refs", []):
                    refs[(ref["dataset_version_id"], ref.get("source_record_id"))] = ref
            facts.append(
                {
                    "id": uid(),
                    "label": f"Приоритет: {zone_names.get(item['zone_id']) or 'участок'}",
                    "metric": {
                        "key": "priority_score",
                        "value": item["score"],
                        "unit": "score_100",
                        "horizon_year": None,
                        "status": "estimated",
                        "lower": None,
                        "upper": None,
                        "qualitative_confidence": "medium",
                        "method_version": "zone-context-ratios-1",
                        "source_refs": list(refs.values()),
                        "missing_reason": None,
                    },
                    "calculation_id": priority.id,
                    "scenario_revision_id": revision_id,
                }
            )
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
            "catalog_version_id": revision.payload.get("catalog_version_id"),
            "rule_version_id": revision.payload.get("rule_version_id"),
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
            facts.extend(snapshot_facts(snapshot.id, revision.id, snapshot.payload))
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


def validate_recommendation_arguments(arguments):
    if not isinstance(arguments, dict) or set(arguments) != RECOMMEND_ARGUMENT_KEYS:
        raise ValueError("shape")
    top_n = arguments["top_n"]
    if not isinstance(top_n, int) or isinstance(top_n, bool) or not 1 <= top_n <= 10:
        raise ValueError("top_n")
    return top_n


def validate_plant_proposal_arguments(arguments):
    if not isinstance(arguments, dict) or set(arguments) != PLANT_PROPOSAL_ARGUMENT_KEYS:
        raise ValueError("shape")
    if arguments["selection_mode"] != "best_for_first_unlocked":
        raise ValueError("selection_mode")
    return arguments["selection_mode"]


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
    tools = []
    if job.request_payload.get("scenario_revision_id") and "specialist" in user.roles:
        tools.append(
            ToolSpec(
                name="calculate_current_scenario",
                description=(
                    "Run the canonical server-owned fast calculation for the exact scenario "
                    "revision bound to this chat. Use only when the user explicitly asks to "
                    "calculate or recalculate the current project. Accept no arguments."
                ),
                parameters={
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {},
                },
            )
        )
    if (
        job.request_payload.get("scenario_revision_id")
        and scenario_context.get("catalog_version_id")
        and scenario_context.get("rule_version_id")
    ):
        tools.append(
            ToolSpec(
                name="recommend_plants",
                description=(
                    "Run the server-owned plant recommendation for the bound scenario and its "
                    "current zone, catalog and rule versions. Use only when the user explicitly "
                    "asks to select or recommend plants. This is read-only."
                ),
                parameters={
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "top_n": {"type": "integer", "minimum": 1, "maximum": 10},
                    },
                    "required": ["top_n"],
                },
            )
        )
    if can_propose:
        if scenario_context.get("catalog_version_id") and scenario_context.get("rule_version_id"):
            tools.append(
                ToolSpec(
                    name="propose_placement_plant",
                    description=(
                        "Prepare, but never apply, a reviewable replacement of the plant in the "
                        "first unlocked placement with the best eligible server-owned catalog "
                        "recommendation that differs from the current plant."
                    ),
                    parameters={
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "selection_mode": {
                                "type": "string",
                                "enum": ["best_for_first_unlocked"],
                            },
                        },
                        "required": ["selection_mode"],
                    },
                ),
            )
        tools.append(
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
    system = (
        "Ты помощник платформы озеленения Павлодара. Отвечай по-русски и только по "
        "AUTHORIZED_CONTEXT. Не придумывай числа, официальность, выполненные действия или "
        "отсутствующие данные. Если значения нет, прямо скажи, что оно недоступно. "
        "Не предлагай обход прав и не выполняй изменения. Для явной просьбы подобрать растения "
        "используй recommend_plants: результат считает сервер по закреплённым версиям. "
        "По явной просьбе рассчитать или пересчитать текущий проект используй "
        "calculate_current_scenario без аргументов: версии, модули и seed выбирает сервер. "
        "Если доступен инструмент предложения, "
        "используй propose_placement_quantity только по явной просьбе изменить количество. "
        "По явной просьбе подготовить лучший рекомендованный вид в проекте используй "
        "propose_placement_plant. Оба инструмента создают только черновик для проверки человеком. "
        "Никогда не показывай JSON, имена полей, UUID или внутренние идентификаторы. Пиши кратко "
        "и понятно специалисту: вывод, 2–5 пунктов объяснения и следующий шаг. Источник каждого "
        "числа интерфейс покажет отдельной серверной карточкой под ответом."
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
            tools=tuple(tools),
        ),
        facts,
    )


def _plant_recommendation(db, access, job, top_n):
    revision_id = job.request_payload.get("scenario_revision_id")
    if not revision_id:
        raise DomainError(422, "invalid_body", "Recommendation requires a bound scenario revision")
    revision = authorized_revision(db, access, revision_id)
    payload = revision.payload
    catalog_id = payload.get("catalog_version_id")
    rule_id = payload.get("rule_version_id")
    if not catalog_id or not rule_id:
        raise DomainError(422, "invalid_body", "Recommendation inputs are not frozen")

    from services.api.catalog import recommend
    from services.api.models import PlantVersion
    from services.api.use_cases import get_zone_version

    zone_version = get_zone_version(db, access, payload["zone_version_id"])
    excluded = list(dict.fromkeys(payload.get("excluded_plant_ids", [])))
    locked = list(
        dict.fromkeys(
            item["plant_id"]
            for item in payload.get("placements", [])
            if item.get("locked") is True and item["plant_id"] not in excluded
        )
    )
    result = recommend(
        db,
        access,
        {
            "zone_version_id": zone_version.id,
            "catalog_version_id": catalog_id,
            "rule_version_id": rule_id,
            "top_n": max(top_n, len(locked)),
            "excluded_plant_ids": excluded,
            "locked_plant_ids": locked,
            "weights": list(RECOMMENDATION_WEIGHTS),
        },
        zone_version,
    )
    candidate_ids = [item["plant_id"] for item in result["candidates"]]
    plant_rows = list(
        db.scalars(
            select(PlantVersion).where(
                PlantVersion.catalog_version_id == catalog_id,
                PlantVersion.plant_id.in_(candidate_ids),
            )
        )
    )
    plant_names = {row.plant_id: row.payload["russian_name"] for row in plant_rows}
    labels = {
        "eligible": "подходит",
        "requires_review": "нужна проверка специалиста",
        "excluded": "исключено правилами",
    }
    lines = ["Подбор выполнен по версии каталога и правилам текущего участка:"]
    for item in result["candidates"][:top_n]:
        name = plant_names.get(item["plant_id"], "Растение каталога")
        score = item.get("score")
        score_text = f" — {round(score)}/100" if score is not None else ""
        lines.append(f"• {name}{score_text} · {labels[item['eligibility']]}")
    lines.append(
        "Проект не изменён. Попросите подготовить замену растения на лучший вариант — "
        "ассистент покажет изменение для вашего подтверждения."
    )
    return revision, result, plant_names, "\n".join(lines)


def _recommend_plants(db, access, job, arguments, facts):
    try:
        top_n = validate_recommendation_arguments(arguments)
    except ValueError as error:
        raise DomainError(
            422, "invalid_body", f"Assistant recommendation arguments are invalid: {error}"
        ) from None
    revision, result, plant_names, text = _plant_recommendation(db, access, job, top_n)
    for item in result["candidates"][:top_n]:
        score = item.get("score")
        if score is None:
            continue
        refs = {}
        for contribution in item.get("contributions", []):
            for ref in contribution.get("source_refs", []):
                refs[(ref["dataset_version_id"], ref.get("source_record_id"))] = ref
        facts.append(
            {
                "id": uid(),
                "label": f"Подбор растений: {plant_names.get(item['plant_id'], 'Растение каталога')}",
                "metric": {
                    "key": "plant_recommendation_score",
                    "value": score,
                    "unit": "score_100",
                    "horizon_year": None,
                    "status": "estimated",
                    "lower": None,
                    "upper": None,
                    "qualitative_confidence": "medium",
                    "method_version": "catalog-rule-recommendation-v1",
                    "source_refs": list(refs.values()),
                    "missing_reason": None,
                },
                "calculation_id": None,
                "scenario_revision_id": revision.id,
            }
        )
    return text


def _calculate_current_scenario(db, access, job, arguments, facts):
    if arguments != {}:
        raise DomainError(
            422,
            "invalid_body",
            "Assistant calculation arguments must be an empty object",
        )
    revision_id = job.request_payload.get("scenario_revision_id")
    if not revision_id:
        raise DomainError(422, "invalid_body", "Calculation requires a bound scenario revision")
    revision = authorized_revision(db, access, revision_id)

    from services.api.calculations import calculate_fast

    result = calculate_fast(
        db,
        access,
        {
            "scenario_revision_id": revision.id,
            "mode": "fast",
            "include_modules": ["cost", "survival", "care", "suitability"],
            "seed": 0,
        },
        uid=uid,
        canonical_hash=canonical_hash,
        now=now,
    )
    snapshot = result["snapshot"]
    facts[:] = [item for item in facts if item.get("calculation_id") is None]
    facts.extend(snapshot_facts(snapshot["id"], revision.id, snapshot))
    if snapshot["status"] == "complete":
        return "Проверочный расчёт сохранён полностью. Точные результаты показаны в карточках ниже."
    return (
        "Проверочный расчёт сохранён частично. Доступные результаты показаны в карточках ниже; "
        "отсутствующие входы и причины сохранены в результате."
    )


def _proposed_revision(db, access, job, reply, message, facts):
    if not reply.tool_calls:
        return None, reply.text
    if len(reply.tool_calls) != 1:
        raise DomainError(422, "invalid_body", "Assistant returned an unsupported proposal")
    if reply.tool_calls[0].name == "recommend_plants":
        return None, _recommend_plants(db, access, job, reply.tool_calls[0].arguments, facts)
    if reply.tool_calls[0].name == "calculate_current_scenario":
        return None, _calculate_current_scenario(
            db, access, job, reply.tool_calls[0].arguments, facts
        )
    tool_name = reply.tool_calls[0].name
    if tool_name not in {"propose_placement_quantity", "propose_placement_plant"}:
        raise DomainError(422, "invalid_body", "Assistant returned an unsupported proposal")
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
    if tool_name == "propose_placement_quantity":
        try:
            _summary, placement_id, quantity = validate_quantity_proposal_arguments(
                reply.tool_calls[0].arguments
            )
        except ValueError as error:
            raise DomainError(
                422, "invalid_body", f"Assistant proposal arguments are invalid: {error}"
            ) from None
        selected = next((item for item in placements if item.get("id") == placement_id), None)
        if selected is None or selected.get("locked") is not False:
            raise DomainError(422, "invalid_body", "Placement is unavailable for this proposal")
        summary = (
            f"Изменить количество в выбранном размещении: {selected['quantity']} → {quantity}"
        )
        selected["quantity"] = quantity
    else:
        try:
            validate_plant_proposal_arguments(reply.tool_calls[0].arguments)
        except ValueError as error:
            raise DomainError(
                422, "invalid_body", f"Assistant plant proposal arguments are invalid: {error}"
            ) from None
        selected = next(
            (item for item in placements if item.get("locked") is False),
            None,
        )
        if selected is None:
            raise DomainError(422, "invalid_body", "No unlocked placement is available")
        _revision, result, plant_names, _text = _plant_recommendation(
            db, access, job, 10
        )
        candidate = next(
            (
                item
                for item in result["candidates"]
                if item.get("eligibility") in {"eligible", "requires_review"}
                and item.get("plant_id") != selected.get("plant_id")
            ),
            None,
        )
        if candidate is None:
            raise DomainError(
                422,
                "invalid_body",
                "No different eligible plant is available for this placement",
            )
        from services.api.models import PlantVersion

        current_row = db.scalar(
            select(PlantVersion).where(
                PlantVersion.catalog_version_id == proposed["catalog_version_id"],
                PlantVersion.plant_id == selected["plant_id"],
            )
        )
        before_name = (
            current_row.payload.get("russian_name", "Текущее растение")
            if current_row
            else "Текущее растение"
        )
        after_name = plant_names.get(candidate["plant_id"], "Рекомендованное растение")
        summary = f"Заменить вид в выбранном размещении: {before_name} → {after_name}"
        selected["plant_id"] = candidate["plant_id"]
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
    return value, summary if tool_name == "propose_placement_plant" else (reply.text or summary)


def persist_chat_reply(db, job, reply, facts):
    user = found(db.get(Principal, job.owner_id))
    access = Access(db, user, None)
    chat_session = session_access(db, access, job.input_ref_id)
    message = found(db.get(ChatMessageRecord, job.request_payload["assistant_message_id"]))
    if message.session_id != chat_session.id or message.job_id != job.id:
        raise DomainError(500, "job_input_invalid", "Assistant message does not match the job")
    proposal, text = _proposed_revision(db, access, job, reply, message, facts)
    message.text = text[:20_000]
    message.state = "completed"
    message.facts = facts
    message.provider = reply.provider
    message.model = reply.model
    message.input_tokens = reply.usage.input_tokens
    message.output_tokens = reply.usage.output_tokens
    message.proposal_id = proposal.id if proposal else None
    return message.id
