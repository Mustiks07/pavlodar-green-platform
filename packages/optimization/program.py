"""Deterministic CP-SAT model for city-program alternative selection."""

from dataclasses import dataclass, field
from time import monotonic

from ortools.sat.python import cp_model

SCALE = 1_000_000


@dataclass(frozen=True)
class Candidate:
    revision_id: str
    zone_id: str
    benefit_score: float
    capital_cents: int
    resources: dict[str, dict[str, int]] = field(default_factory=dict)
    stock: dict[str, int] = field(default_factory=dict)
    taxa: dict[tuple[str, str], int] = field(default_factory=dict)
    total_plants: int = 0


@dataclass(frozen=True)
class DiversityCap:
    level: str
    key: str
    scope: str
    maximum_fraction: float


@dataclass(frozen=True)
class Problem:
    candidates: tuple[Candidate, ...]
    capital_budget_cents: int
    resource_limits: dict[str, dict[str, int | None]]
    stock_limits: dict[str, int]
    required_zones: frozenset[str]
    excluded_zones: frozenset[str]
    coverage: tuple[tuple[frozenset[str], int], ...]
    diversity_caps: tuple[DiversityCap, ...]


@dataclass(frozen=True)
class Solution:
    status: str
    selected_revision_ids: tuple[str, ...]
    objective: float | None
    best_bound: float | None
    gap: float | None
    elapsed_seconds: float
    capital_total_cents: int | None


def _scaled(value):
    return round(value * SCALE)


def solve(problem: Problem, *, time_limit_seconds: int, seed: int) -> Solution:
    started = monotonic()
    model = cp_model.CpModel()
    ordered = sorted(problem.candidates, key=lambda item: item.revision_id)
    selected = {item.revision_id: model.new_bool_var(f"candidate_{index}") for index, item in enumerate(ordered)}
    by_zone = {}
    for item in ordered:
        by_zone.setdefault(item.zone_id, []).append(selected[item.revision_id])
    for zone_id, variables in by_zone.items():
        model.add(sum(variables) <= 1)
        if zone_id in problem.required_zones:
            model.add(sum(variables) == 1)
        if zone_id in problem.excluded_zones:
            model.add(sum(variables) == 0)
    for zone_id in problem.required_zones - set(by_zone):
        model.add(False)

    for zones, minimum in problem.coverage:
        model.add(
            sum(
                selected[item.revision_id]
                for item in ordered
                if item.zone_id in zones
            )
            >= minimum
        )

    model.add(
        sum(item.capital_cents * selected[item.revision_id] for item in ordered)
        <= problem.capital_budget_cents
    )
    for period, limits in problem.resource_limits.items():
        for resource, limit in limits.items():
            if limit is not None:
                model.add(
                    sum(
                        item.resources.get(period, {}).get(resource, 0)
                        * selected[item.revision_id]
                        for item in ordered
                    )
                    <= limit
                )
    for stock_id, limit in problem.stock_limits.items():
        model.add(
            sum(item.stock.get(stock_id, 0) * selected[item.revision_id] for item in ordered)
            <= limit
        )

    for cap in problem.diversity_caps:
        ratio = _scaled(cap.maximum_fraction)
        if cap.scope == "program":
            model.add(
                sum(
                    item.taxa.get((cap.level, cap.key), 0)
                    * SCALE
                    * selected[item.revision_id]
                    for item in ordered
                )
                <= sum(
                    item.total_plants * ratio * selected[item.revision_id] for item in ordered
                )
            )
        else:
            for item in ordered:
                if item.taxa.get((cap.level, cap.key), 0) * SCALE > item.total_plants * ratio:
                    model.add(selected[item.revision_id] == 0)

    objective_expression = sum(
        _scaled(item.benefit_score) * selected[item.revision_id] for item in ordered
    )
    model.maximize(objective_expression)
    model.add_decision_strategy(
        [selected[item.revision_id] for item in ordered],
        cp_model.CHOOSE_FIRST,
        cp_model.SELECT_MIN_VALUE,
    )
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit_seconds
    solver.parameters.random_seed = seed
    solver.parameters.num_search_workers = 1
    solver.parameters.search_branching = cp_model.FIXED_SEARCH
    status_code = solver.solve(model)
    elapsed = monotonic() - started
    status = {
        cp_model.OPTIMAL: "optimal",
        cp_model.FEASIBLE: "feasible",
        cp_model.INFEASIBLE: "infeasible",
        cp_model.MODEL_INVALID: "unknown",
        cp_model.UNKNOWN: "timeout" if elapsed >= time_limit_seconds * 0.95 else "unknown",
    }[status_code]
    if status not in {"optimal", "feasible"}:
        return Solution(status, (), None, None, None, elapsed, None)
    chosen = tuple(
        item.revision_id for item in ordered if solver.value(selected[item.revision_id])
    )
    objective = solver.objective_value / SCALE
    bound = solver.best_objective_bound / SCALE
    gap = max(0.0, bound - objective) / max(abs(objective), 1.0)
    capital = sum(item.capital_cents for item in ordered if item.revision_id in chosen)
    return Solution(
        status,
        chosen,
        round(objective, 6),
        round(bound, 6),
        round(gap, 9),
        elapsed,
        capital,
    )
