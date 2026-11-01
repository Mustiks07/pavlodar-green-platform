"""Server-built, reviewable scenario proposals with optimistic concurrency."""

from datetime import UTC, datetime

from sqlalchemy import select

from packages.domain.errors import DomainError
from services.api.models import ProposalRecord, Scenario
from services.api.use_cases import (
    audit,
    conditional,
    found,
    get_scenario,
    save_revision,
)


def proposal_payload(value):
    return {
        "id": value.id,
        "scenario_id": value.scenario_id,
        "base_revision_id": value.base_revision_id,
        "status": value.status,
        "summary": value.summary,
        "proposed_revision": value.proposed_revision,
        "expires_at": value.expires_at.isoformat().replace("+00:00", "Z"),
    }


def proposal_access(db, access, proposal_id, lock=False):
    statement = select(ProposalRecord).where(ProposalRecord.id == proposal_id)
    value = found(db.scalar(statement.with_for_update() if lock else statement))
    get_scenario(db, access, value.scenario_id)
    if value.owner_id != access.user.id and access.level < 2:
        raise DomainError(404, "not_found", "Object not found")
    return value


def _expire(value):
    if value.status == "pending" and value.expires_at <= datetime.now(UTC):
        value.status = "expired"
        value.decided_at = datetime.now(UTC)
        value.decision_reason = "Proposal validity period expired"


def get_proposal(db, access, proposal_id):
    value = proposal_access(db, access, proposal_id, lock=True)
    _expire(value)
    return proposal_payload(value)


def _require_pending(value, scenario):
    _expire(value)
    if value.status != "pending":
        raise DomainError(
            412,
            "revision_conflict",
            "Proposal is no longer pending",
            current_revision_id=scenario.current_revision_id,
        )


def apply_proposal(db, access, proposal_id, body, request):
    value = proposal_access(db, access, proposal_id, lock=True)
    scenario = get_scenario(db, access, value.scenario_id, lock=True)
    conditional(request, scenario.payload, scenario.current_revision_id)
    _require_pending(value, scenario)
    if body["base_revision_id"] != value.base_revision_id:
        raise DomainError(
            412,
            "revision_conflict",
            "Proposal base does not match the request",
            current_revision_id=scenario.current_revision_id,
        )
    if scenario.current_revision_id != value.base_revision_id:
        raise DomainError(
            412,
            "revision_conflict",
            "Scenario changed after this proposal was prepared",
            current_revision_id=scenario.current_revision_id,
        )
    if scenario.status != "draft":
        raise DomainError(409, "scenario_not_draft", "Only drafts accept new revisions")
    result = save_revision(db, access, scenario, value.proposed_revision)
    value.status = "applied"
    value.decided_at = datetime.now(UTC)
    audit(db, access, "proposal.applied", value.id, "Proposal")
    return result, scenario


def reject_proposal(db, access, proposal_id, body):
    value = proposal_access(db, access, proposal_id, lock=True)
    scenario = found(db.get(Scenario, value.scenario_id))
    _require_pending(value, scenario)
    value.status = "rejected"
    value.decided_at = datetime.now(UTC)
    value.decision_reason = body["reason"]
    audit(db, access, "proposal.rejected", value.id, "Proposal", body["reason"])
    return proposal_payload(value)
