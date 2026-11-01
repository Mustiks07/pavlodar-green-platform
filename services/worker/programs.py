"""Build authoritative program candidates and persist immutable CP-SAT revisions."""

from collections import defaultdict
from datetime import datetime
from decimal import ROUND_CEILING, Decimal

from sqlalchemy import select

from packages.domain.contracts import validate
from packages.domain.errors import gap
from packages.optimization.program import Candidate, DiversityCap, Problem, solve
from services.api.models import (
    CalculationSnapshotRecord,
    Dataset,
    Job,
    PlantVersion,
    Principal,
    Program,
    ProgramInputVersion,
    ProgramRevisionCalculation,
    ProgramRevisionRecord,
    Scenario,
    StockItemRecord,
)
from services.api.priorities import authorized_priority_result
from services.api.programs import validate_program_input
from services.api.security import Access
from services.api.use_cases import audit, authorized_revision, found, now, uid


def _cents(value):
    return int((Decimal(value) * 100).to_integral_exact())


def _litres(value):
    return int((Decimal(str(value)) * 1000).to_integral_value(rounding=ROUND_CEILING))


def _calculation(db, revision_id):
    jobs = list(
        db.scalars(
            select(Job).where(
                Job.input_revision_id == revision_id,
                Job.input_kind == "revision",
                Job.state == "succeeded",
            )
        )
    )
    jobs.sort(key=lambda item: (item.payload["created_at"], item.id), reverse=True)
    for job in jobs:
        request = job.request_payload or {}
        if (
            job.payload.get("kind") != "calculate"
            or request.get("mode") != "full"
            or not {"cost", "care"}.issubset(set(request.get("include_modules", [])))
        ):
            continue
        snapshot = db.get(CalculationSnapshotRecord, job.payload.get("result_ref_id"))
        if (
            snapshot
            and snapshot.scenario_revision_id == revision_id
            and snapshot.payload["status"] == "complete"
            and snapshot.payload["cost"]["status"] == "complete"
            and snapshot.payload["cost"]["total"] is not None
            and not any(item["blocking"] for item in snapshot.payload["warnings"])
        ):
            return snapshot
    return None


def _candidate_resources(snapshot):
    resources = defaultdict(lambda: defaultdict(int))
    for operation in snapshot.payload["care"]:
        period = f"year:{operation['year_offset']}"
        resources[period]["water_litres"] += _litres(operation["water_m3"])
        resources[period]["crew_minutes"] += operation["crew_minutes"]
        resources[period]["max_visits"] += operation["visits"]
    for line in snapshot.payload["cost"]["lines"]:
        if line["category"] in {"care", "water"} and line["subtotal"] is not None:
            resources[f"year:{line['year']}"]["care_budget_cents"] += _cents(
                line["subtotal"]
            )
    return {period: dict(values) for period, values in resources.items()}


def _candidate_inventory(db, access, revision, caps):
    stock = defaultdict(int)
    stock_limits = {}
    taxa = defaultdict(int)
    total = 0
    blockers = []
    for placement in revision.payload["placements"]:
        quantity = placement["quantity"]
        total += quantity
        stock_id = placement["stock_item_id"]
        item = db.get(StockItemRecord, stock_id) if stock_id else None
        if item:
            access.dataset(found(db.get(Dataset, item.dataset_id)))
        if not item or item.payload["available_quantity"] is None:
            blockers.append(
                gap(
                    "program_stock_unavailable",
                    "Candidate placement has no exact frozen stock quantity",
                    revision.id,
                    placement["id"],
                )
            )
        elif item.plant_id != placement["plant_id"]:
            blockers.append(
                gap(
                    "program_stock_unavailable",
                    "Candidate stock item does not match its plant",
                    revision.id,
                    placement["id"],
                )
            )
        else:
            stock[stock_id] += quantity
            stock_limits[stock_id] = item.payload["available_quantity"]

        plant = (
            db.get(PlantVersion, (revision.payload["catalog_version_id"], placement["plant_id"]))
            if revision.payload["catalog_version_id"]
            else None
        )
        latin = plant.payload["latin_name"].strip() if plant else ""
        for cap in caps:
            if cap["taxon_level"] == "family":
                blockers.append(
                    gap(
                        "program_taxonomy_unavailable",
                        "Family-level diversity requires a frozen family field",
                        revision.id,
                        cap["taxon_key"],
                    )
                )
            elif cap["taxon_level"] == "genus" and latin.split(" ", 1)[0].casefold() == cap[
                "taxon_key"
            ].casefold():
                taxa[("genus", cap["taxon_key"])] += quantity
            elif cap["taxon_level"] == "species" and latin.casefold() == cap[
                "taxon_key"
            ].casefold():
                taxa[("species", cap["taxon_key"])] += quantity
    return dict(stock), stock_limits, dict(taxa), total, blockers


def build_problem(db, access, input_version):
    body = input_version.payload
    priority = authorized_priority_result(db, access, body["priority_result_id"]).payload
    priority_by_zone = {item["zone_id"]: item for item in priority["zones"]}
    candidates = []
    stock_limits = {}
    blockers = []
    snapshot_ids = []
    for revision_id in body["candidate_revision_ids"]:
        revision = authorized_revision(db, access, revision_id)
        scenario = found(db.get(Scenario, revision.scenario_id))
        score = priority_by_zone[scenario.zone_id]["score"]
        snapshot = _calculation(db, revision.id)
        if score is None:
            blockers.append(
                gap(
                    "program_priority_incomplete",
                    "Candidate zone has incomplete weighted priority data",
                    revision.id,
                    scenario.zone_id,
                )
            )
        if snapshot is None:
            blockers.append(
                gap(
                    "program_calculation_incomplete",
                    "Candidate needs a complete durable cost and care calculation",
                    revision.id,
                )
            )
        stock, limits, taxa, total, inventory_gaps = _candidate_inventory(
            db, access, revision, body["diversity_caps"]
        )
        blockers.extend(inventory_gaps)
        if score is None or snapshot is None or inventory_gaps:
            continue
        stock_limits.update(limits)
        snapshot_ids.append(snapshot.id)
        candidates.append(
            Candidate(
                revision_id=revision.id,
                zone_id=scenario.zone_id,
                benefit_score=score,
                capital_cents=_cents(snapshot.payload["cost"]["total"]),
                resources=_candidate_resources(snapshot),
                stock=stock,
                taxa=taxa,
                total_plants=total,
            )
        )
    limits = {}
    for item in body["resource_limits"]:
        limits[item["period"]] = {
            "water_litres": _litres(item["water_m3"])
            if item["water_m3"] is not None
            else None,
            "crew_minutes": item["crew_minutes"],
            "max_visits": item["max_visits"],
            "care_budget_cents": _cents(item["care_budget"])
            if item["care_budget"] is not None
            else None,
        }
    problem = Problem(
        candidates=tuple(candidates),
        capital_budget_cents=_cents(body["capital_budget"]),
        resource_limits=limits,
        stock_limits=stock_limits,
        required_zones=frozenset(body["required_zone_ids"]),
        excluded_zones=frozenset(body["excluded_zone_ids"]),
        coverage=tuple(
            (frozenset(item["zone_ids"]), item["minimum_selected_zones"])
            for item in body["coverage_requirements"]
        ),
        diversity_caps=tuple(
            DiversityCap(
                item["taxon_level"],
                item["taxon_key"],
                item["scope"],
                item["maximum_fraction"],
            )
            for item in body["diversity_caps"]
        ),
    )
    return problem, blockers, snapshot_ids


def persist_optimization(db, job):
    user = found(db.get(Principal, job.owner_id))
    access = Access(db, user, None)
    input_version = found(db.get(ProgramInputVersion, job.input_ref_id))
    validate_program_input(db, access, input_version.payload)
    problem, blockers, snapshot_ids = build_problem(db, access, input_version)
    if problem.candidates:
        solution = solve(
            problem,
            time_limit_seconds=job.request_payload["time_limit_seconds"],
            seed=job.request_payload["seed"],
        )
    else:
        from packages.optimization.program import Solution

        solution = Solution("unknown", (), None, None, None, 0.0, None)
    if solution.status == "infeasible":
        blockers.append(
            gap(
                "program_infeasible",
                "No candidate set satisfies every hard program constraint",
                input_version.id,
            )
        )
    revision_id, created_at = uid(), now()
    payload = {
        "id": revision_id,
        "program_id": input_version.program_id,
        "selected_scenario_revision_ids": list(solution.selected_revision_ids),
        "calculation_snapshot_ids": snapshot_ids,
        "solver_status": solution.status,
        "objective": solution.objective,
        "best_bound": solution.best_bound,
        "gap": solution.gap,
        "elapsed_seconds": solution.elapsed_seconds,
        "capital_total": f"{Decimal(solution.capital_total_cents) / 100:.2f}"
        if solution.capital_total_cents is not None
        else None,
        "constraint_violations": blockers,
        "input_snapshot": input_version.payload,
        "created_at": created_at,
    }
    validate("ProgramRevision", payload)
    db.add(
        ProgramRevisionRecord(
            id=revision_id,
            program_id=input_version.program_id,
            input_version_id=input_version.id,
            job_id=job.id,
            payload=payload,
            created_at=datetime.fromisoformat(created_at),
        )
    )
    db.flush()
    for snapshot_id in snapshot_ids:
        db.add(
            ProgramRevisionCalculation(
                program_revision_id=revision_id,
                calculation_snapshot_id=snapshot_id,
            )
        )
    program = found(db.get(Program, input_version.program_id))
    if program.current_input_version_id == input_version.id:
        program.current_revision_id = revision_id
        program.payload = {**program.payload, "current_revision_id": revision_id, "updated_at": created_at}
        program.updated_at = datetime.fromisoformat(created_at)
    audit(db, access, "program.optimized", revision_id, "ProgramRevision")
    return revision_id


def revalidation_blockers(db, access, program, revision, *, approval=False):
    blockers = []
    if revision.input_version_id != program.current_input_version_id:
        blockers.append(
            gap(
                "program_revision_stale",
                "Program inputs changed after this solver revision",
                revision.input_version_id,
                program.current_input_version_id,
            )
        )
        return blockers
    input_version = found(db.get(ProgramInputVersion, revision.input_version_id))
    validate_program_input(db, access, input_version.payload)
    problem, current_gaps, snapshot_ids = build_problem(db, access, input_version)
    blockers.extend(current_gaps)
    recorded_ids = set(revision.payload["calculation_snapshot_ids"])
    if recorded_ids != set(snapshot_ids):
        blockers.append(
            gap(
                "program_revision_stale",
                "Eligible calculation lineage changed after optimization",
                *sorted(recorded_ids ^ set(snapshot_ids)),
            )
        )
    job = found(db.get(Job, revision.job_id))
    solution = solve(
        problem,
        time_limit_seconds=min(job.request_payload["time_limit_seconds"], 30),
        seed=job.request_payload["seed"],
    )
    if (
        solution.status != "optimal"
        or tuple(revision.payload["selected_scenario_revision_ids"])
        != solution.selected_revision_ids
        or revision.payload["objective"] != solution.objective
    ):
        blockers.append(
            gap(
                "program_revalidation_failed",
                "Current authoritative inputs do not reproduce the recorded optimal solution",
                revision.id,
            )
        )
    if revision.payload["constraint_violations"]:
        blockers.extend(revision.payload["constraint_violations"])
    if not revision.payload["selected_scenario_revision_ids"]:
        blockers.append(
            gap(
                "program_selection_empty",
                "An approved program must select at least one scenario",
                revision.id,
            )
        )
    if approval:
        for revision_id in revision.payload["selected_scenario_revision_ids"]:
            scenario_revision = authorized_revision(db, access, revision_id)
            scenario = found(db.get(Scenario, scenario_revision.scenario_id))
            if scenario_revision.payload["synthetic_inputs"]:
                blockers.append(
                    gap(
                        "program_approval_synthetic",
                        "Synthetic scenario inputs cannot be internally approved",
                        revision_id,
                    )
                )
            if scenario.status != "approved":
                blockers.append(
                    gap(
                        "program_scenario_not_approved",
                        "Every selected scenario must be approved first",
                        scenario.id,
                    )
                )
    return blockers
