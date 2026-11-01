"""Detected problems derived from current zone geometry and published restrictions."""

import base64
import json
from datetime import UTC, datetime
from uuid import NAMESPACE_URL, UUID, uuid5

from packages.domain.errors import DomainError
from services.api.models import (
    Dataset,
    ProblemDecisionRecord,
    RuleVersionRecord,
    Zone,
    ZoneVersion,
)
from services.api.zone_context import build_zone_context


def _classification(kind):
    value = kind.lower()
    if any(token in value for token in ("heat", "жар", "перегрев")):
        return "heat", "high", "Добавить затенение и проверить устойчивые к жаре посадки"
    if any(token in value for token in ("soil", "почв", "salt", "засол")):
        return "soil_risk", "high", "Провести почвенное обследование до утверждения посадок"
    if any(token in value for token in ("degrad", "авар", "усых", "dead")):
        return "degraded_green", "high", "Назначить обследование и план восстановления зелени"
    if any(token in value for token in ("protect", "санитар", "защит")):
        return (
            "missing_protective_green",
            "medium",
            "Проверить норматив защитной полосы и подготовить вариант озеленения",
        )
    return "data_gap", "medium", "Учесть ограничение при подготовке и согласовании сценария"


def _metric(context, key):
    return next((item for item in context["metrics"] if item["key"] == key), None)


def _green_coverage_rule(db, access, city_id):
    """Return an accessible versioned target; never embed a hidden city threshold."""
    candidates = []
    for rule in db.query(RuleVersionRecord).order_by(RuleVersionRecord.id).all():
        payload = rule.payload
        if payload.get("parameter") not in {"green_coverage_target", "minimum_green_fraction"}:
            continue
        value = payload.get("value")
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 < value <= 1:
            continue
        dataset = db.get(Dataset, rule.dataset_id)
        if dataset is None or dataset.city_id != city_id:
            continue
        try:
            access.dataset(dataset)
        except DomainError as error:
            if error.status in {403, 404}:
                continue
            raise
        if payload.get("review_status") == "expert_confirmed" and payload.get("superseded_by") is None:
            candidates.append(rule)
    return candidates[-1] if candidates else None


def _green_deficit_problem(db, access, zone, version, context):
    rule = _green_coverage_rule(db, access, zone.city_id)
    area = _metric(context, "zone_area")
    green = _metric(context, "existing_green_area")
    if (
        rule is None
        or area is None
        or green is None
        or area["value"] in {None, 0}
        or green["value"] is None
    ):
        return None
    coverage = max(0.0, min(1.0, float(green["value"]) / float(area["value"])))
    target = float(rule.payload["value"])
    if coverage >= target:
        return None
    relative = coverage / target
    severity = "high" if relative < 0.4 else "medium" if relative < 0.75 else "low"
    identity = str(uuid5(NAMESPACE_URL, f"pavlodar:green-deficit:{version.id}:{rule.id}"))
    decision = db.get(ProblemDecisionRecord, identity)
    refs = {
        (item["dataset_version_id"], item.get("source_record_id")): item
        for item in [*context["source_refs"], rule.payload["source"]]
    }
    return {
        "id": identity,
        "zone_id": zone.id,
        "kind": "green_deficit",
        "severity": severity,
        "description": (
            f"Существующая зелень занимает {coverage:.0%} площади участка "
            f"при целевом ориентире {target:.0%}"
        ),
        "recommendation": "Подготовить вариант многоярусного озеленения и сравнить эффект со стоимостью ухода",
        "rule_version_id": rule.id,
        "source_refs": sorted(
            refs.values(),
            key=lambda item: (item["dataset_version_id"], item.get("source_record_id") or ""),
        ),
        "status": decision.status if decision else "open",
        "dismissal_reason": decision.reason if decision else None,
    }


def _derived(db, access, city_id):
    values = []
    zones = db.query(Zone).filter(Zone.city_id == city_id).order_by(Zone.id).all()
    for zone in zones:
        version = db.get(ZoneVersion, zone.current_version_id)
        if version is None:
            continue
        context = build_zone_context(db, access, zone, version)
        green_deficit = _green_deficit_problem(db, access, zone, version, context)
        if green_deficit:
            values.append(green_deficit)
        for restriction in context["restrictions"]:
            rule = db.get(RuleVersionRecord, restriction["rule_version_id"])
            if rule is None:
                continue
            try:
                access.dataset(db.get(Dataset, rule.dataset_id))
            except DomainError as error:
                if error.status in {403, 404}:
                    continue
                raise
            kind, severity, recommendation = _classification(restriction["kind"])
            decision = db.get(ProblemDecisionRecord, restriction["id"])
            values.append(
                {
                    "id": restriction["id"],
                    "zone_id": zone.id,
                    "kind": kind,
                    "severity": severity,
                    "description": f"На участке действует ограничение: {restriction['kind']}",
                    "recommendation": recommendation,
                    "rule_version_id": restriction["rule_version_id"],
                    "source_refs": context["source_refs"],
                    "status": decision.status if decision else "open",
                    "dismissal_reason": decision.reason if decision else None,
                }
            )
    return sorted(values, key=lambda item: item["id"])


def list_problems(db, access, params):
    access.city(params["city_id"])
    values = _derived(db, access, params["city_id"])
    if params.get("severity"):
        values = [item for item in values if item["severity"] == params["severity"]]
    if params.get("kind"):
        values = [item for item in values if item["kind"] == params["kind"]]
    after = None
    if params.get("cursor"):
        try:
            after = str(UUID(json.loads(base64.urlsafe_b64decode(params["cursor"]))["after"]))
        except (ValueError, KeyError, TypeError, json.JSONDecodeError):
            raise DomainError(422, "invalid_cursor", "Problem cursor is invalid") from None
        values = [item for item in values if item["id"] > after]
    limit = int(params.get("limit", 50))
    page = values[:limit]
    next_cursor = None
    if len(values) > limit:
        next_cursor = base64.urlsafe_b64encode(
            json.dumps({"after": page[-1]["id"]}).encode()
        ).decode()
    return {"items": page, "next_cursor": next_cursor}


def dismiss_problem(db, access, problem_id, reason, *, city_ids):
    access.role("specialist")
    if db.get(ProblemDecisionRecord, problem_id):
        raise DomainError(409, "problem_already_decided", "Problem already has a decision")
    found = None
    for city_id in city_ids:
        for problem in _derived(db, access, city_id):
            if problem["id"] == problem_id:
                found = problem
                break
        if found:
            break
    if found is None:
        raise DomainError(404, "not_found", "Problem was not found")
    db.add(
        ProblemDecisionRecord(
            problem_id=problem_id,
            zone_id=found["zone_id"],
            actor_id=access.user.id,
            status="dismissed",
            reason=reason,
            decided_at=datetime.now(UTC),
        )
    )
    return {**found, "status": "dismissed", "dismissal_reason": reason}
