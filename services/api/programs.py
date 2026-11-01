"""Immutable city-program inputs and their authorization/validation rules."""

from datetime import datetime
from decimal import Decimal

from sqlalchemy import select

from packages.domain.errors import DomainError
from services.api.models import (
    Program,
    ProgramInputCandidate,
    ProgramInputVersion,
    Scenario,
)
from services.api.use_cases import authorized_revision, found


def _unique(values, code, detail):
    if len(values) != len(set(values)):
        raise DomainError(422, code, detail)


def validate_program_input(db, access, body):
    candidate_ids = body["candidate_revision_ids"]
    _unique(candidate_ids, "program_candidates_invalid", "Candidate revisions must be unique")
    weights = body["benefit_weights"]
    _unique(
        [item["factor"] for item in weights],
        "program_weights_invalid",
        "Benefit factors must be unique",
    )
    if sum((Decimal(str(item["weight"])) for item in weights), Decimal(0)) <= 0:
        raise DomainError(422, "program_weights_invalid", "At least one benefit weight must be positive")
    _unique(
        [item["period"] for item in body["resource_limits"]],
        "program_resources_invalid",
        "Resource periods must be unique",
    )

    revisions = [authorized_revision(db, access, revision_id) for revision_id in candidate_ids]
    zone_ids = []
    for revision in revisions:
        scenario = found(db.get(Scenario, revision.scenario_id))
        if scenario.city_id != body["city_id"]:
            raise DomainError(422, "city_mismatch", "Every candidate must belong to the program city")
        zone_ids.append(scenario.zone_id)
    candidate_zones = set(zone_ids)

    priority_result_id = body.get("priority_result_id")
    if priority_result_id:
        from services.api.priorities import authorized_priority_result

        priority = authorized_priority_result(db, access, priority_result_id).payload
        if priority["city_id"] != body["city_id"]:
            raise DomainError(422, "city_mismatch", "Priority result belongs to another city")
        priority_zones = {item["zone_id"] for item in priority["zones"]}
        if not candidate_zones <= priority_zones:
            raise DomainError(
                422,
                "program_priority_invalid",
                "Priority result must contain every candidate zone",
            )
        expected = {item["factor"]: Decimal(str(item["weight"])) for item in priority["weights"]}
        actual = {item["factor"]: Decimal(str(item["weight"])) for item in weights}
        if actual != expected:
            raise DomainError(
                422,
                "program_priority_invalid",
                "Program benefit weights must equal the immutable priority weights",
            )

    required = body["required_zone_ids"]
    excluded = body["excluded_zone_ids"]
    _unique(required, "program_zones_invalid", "Required zones must be unique")
    _unique(excluded, "program_zones_invalid", "Excluded zones must be unique")
    if set(required) & set(excluded):
        raise DomainError(422, "program_zones_invalid", "A zone cannot be required and excluded")
    if not set(required + excluded).issubset(candidate_zones):
        raise DomainError(422, "program_zones_invalid", "Program zones must have a candidate")

    groups = []
    for requirement in body["coverage_requirements"]:
        groups.append(requirement["group_id"])
        zones = requirement["zone_ids"]
        _unique(zones, "program_coverage_invalid", "Coverage zones must be unique")
        if not set(zones).issubset(candidate_zones):
            raise DomainError(422, "program_coverage_invalid", "Coverage zones need candidates")
        if requirement["minimum_selected_zones"] > len(zones):
            raise DomainError(
                422,
                "program_coverage_invalid",
                "Minimum selected zones exceeds the coverage group",
            )
    _unique(groups, "program_coverage_invalid", "Coverage group ids must be unique")

    caps = [
        (item["taxon_level"], item["taxon_key"], item["scope"])
        for item in body["diversity_caps"]
    ]
    _unique(caps, "program_diversity_invalid", "Diversity caps must be unique")
    return revisions


def program_access(db, access, program):
    access.city(program.city_id)
    if program.status != "approved" and program.owner_id != access.user.id and access.level < 2:
        raise DomainError(404, "not_found", "Object not found")
    candidates = db.scalars(
        select(ProgramInputCandidate).where(
            ProgramInputCandidate.input_version_id == program.current_input_version_id
        )
    )
    for candidate in candidates:
        authorized_revision(db, access, candidate.scenario_revision_id)
    return program


def get_program(db, access, program_id, *, lock=False, mutate=False):
    statement = select(Program).where(Program.id == program_id)
    program = found(db.scalar(statement.with_for_update() if lock else statement))
    program_access(db, access, program)
    if mutate and program.owner_id != access.user.id and access.level < 2:
        raise DomainError(404, "not_found", "Object not found")
    return program


def save_program_input(db, access, program, body, input_id, parent_id, created_at):
    version = ProgramInputVersion(
        id=input_id,
        program_id=program.id,
        parent_id=parent_id,
        actor_id=access.user.id,
        priority_result_id=body.get("priority_result_id"),
        payload=body,
        created_at=datetime.fromisoformat(created_at),
    )
    db.add(version)
    db.flush()
    for revision_id in body["candidate_revision_ids"]:
        db.add(
            ProgramInputCandidate(
                input_version_id=input_id,
                scenario_revision_id=revision_id,
            )
        )
    return version


def program_revision_access(db, access, revision, *, authorized_program=None):
    program = authorized_program or found(db.get(Program, revision.program_id))
    if program.id != revision.program_id:
        raise DomainError(404, "not_found", "Object not found")
    if authorized_program is None:
        program_access(db, access, program)
    snapshot = revision.payload["input_snapshot"]
    current = program.payload
    # get_program already authorizes the current candidate set. Most optimization revisions vary
    # only by budget/resource limits; re-authorizing every candidate for every row caused an N×M
    # query fan-out on the decision screen. Revalidate only revisions that reference a different
    # access-sensitive graph.
    access_keys = ("city_id", "candidate_revision_ids", "priority_result_id")
    if any(snapshot.get(key) != current.get(key) for key in access_keys):
        validate_program_input(db, access, snapshot)
    return revision


def program_revision_diff(base, target):
    def changed_ids(field):
        before = set(base.payload[field])
        after = set(target.payload[field])
        return sorted(after - before), sorted(before - after)

    added_scenarios, removed_scenarios = changed_ids("selected_scenario_revision_ids")
    added_calculations, removed_calculations = changed_ids("calculation_snapshot_ids")
    base_input = base.payload["input_snapshot"]
    target_input = target.payload["input_snapshot"]
    changed_fields = sorted(
        key
        for key in set(base_input) | set(target_input)
        if base_input.get(key) != target_input.get(key)
    )
    base_objective = base.payload["objective"]
    target_objective = target.payload["objective"]
    objective_delta = None
    if base_objective is not None and target_objective is not None:
        objective_delta = float(Decimal(str(target_objective)) - Decimal(str(base_objective)))
    base_capital = base.payload["capital_total"]
    target_capital = target.payload["capital_total"]
    capital_delta = None
    if base_capital is not None and target_capital is not None:
        capital_delta = f"{Decimal(target_capital) - Decimal(base_capital):.2f}"
        if capital_delta == "-0.00":
            capital_delta = "0.00"
    return {
        "program_id": base.program_id,
        "base_revision": base.payload,
        "target_revision": target.payload,
        "added_scenario_revision_ids": added_scenarios,
        "removed_scenario_revision_ids": removed_scenarios,
        "added_calculation_snapshot_ids": added_calculations,
        "removed_calculation_snapshot_ids": removed_calculations,
        "changed_input_fields": changed_fields,
        "objective_delta": objective_delta,
        "capital_delta": capital_delta,
    }
