from packages.optimization.program import Candidate, DiversityCap, Problem, solve


def candidate(identity, zone, benefit, cost, *, water=0, stock=0, genus=0, total=10):
    return Candidate(
        revision_id=identity,
        zone_id=zone,
        benefit_score=benefit,
        capital_cents=cost,
        resources={"year:0": {"water_litres": water}},
        stock={"stock-a": stock},
        taxa={("genus", "Ulmus"): genus},
        total_plants=total,
    )


def problem(candidates, **changes):
    values = {
        "candidates": tuple(candidates),
        "capital_budget_cents": 10_000,
        "resource_limits": {"year:0": {"water_litres": 10_000}},
        "stock_limits": {"stock-a": 100},
        "required_zones": frozenset(),
        "excluded_zones": frozenset(),
        "coverage": (),
        "diversity_caps": (),
    }
    values.update(changes)
    return Problem(**values)


def test_cp_sat_selects_real_alternatives_under_budget_and_resources():
    result = solve(
        problem(
            [
                candidate("a-cheap", "zone-a", 80, 4_000, water=3_000),
                candidate("a-expensive", "zone-a", 90, 7_000, water=5_000),
                candidate("b", "zone-b", 70, 4_000, water=3_000),
            ],
            required_zones=frozenset({"zone-a"}),
            coverage=((frozenset({"zone-a", "zone-b"}), 2),),
        ),
        time_limit_seconds=5,
        seed=7,
    )
    assert result.status == "optimal"
    assert result.selected_revision_ids == ("a-cheap", "b")
    assert result.objective == 150
    assert result.capital_total_cents == 8_000
    assert result.gap == 0


def test_cp_sat_enforces_stock_and_program_diversity():
    result = solve(
        problem(
            [
                candidate("a", "zone-a", 80, 1_000, stock=6, genus=10),
                candidate("b", "zone-b", 70, 1_000, stock=6, genus=0),
                candidate("c", "zone-c", 60, 1_000, stock=4, genus=0),
            ],
            stock_limits={"stock-a": 10},
            diversity_caps=(DiversityCap("genus", "Ulmus", "program", 0.5),),
        ),
        time_limit_seconds=5,
        seed=1,
    )
    assert result.status == "optimal"
    assert result.selected_revision_ids == ("a", "c")


def test_cp_sat_reports_infeasible_instead_of_relaxing_required_constraints():
    result = solve(
        problem(
            [candidate("a", "zone-a", 80, 20_000)],
            required_zones=frozenset({"zone-a"}),
        ),
        time_limit_seconds=5,
        seed=0,
    )
    assert result.status == "infeasible"
    assert result.selected_revision_ids == ()
    assert result.objective is None
    assert result.capital_total_cents is None
