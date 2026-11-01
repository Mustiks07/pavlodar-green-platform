from types import SimpleNamespace

from services.api.programs import program_revision_diff


def revision(revision_id, scenarios, calculations, objective, capital, input_snapshot):
    return SimpleNamespace(
        program_id="00000000-0000-4000-8000-000000000001",
        payload={
            "id": revision_id,
            "program_id": "00000000-0000-4000-8000-000000000001",
            "selected_scenario_revision_ids": scenarios,
            "calculation_snapshot_ids": calculations,
            "solver_status": "optimal",
            "objective": objective,
            "best_bound": objective,
            "gap": 0,
            "elapsed_seconds": 0.1,
            "capital_total": capital,
            "constraint_violations": [],
            "input_snapshot": input_snapshot,
            "created_at": "2026-10-30T12:00:00+00:00",
        },
    )


def test_program_revision_diff_reports_directional_server_deltas():
    scenario_a = "00000000-0000-4000-8000-000000000011"
    scenario_b = "00000000-0000-4000-8000-000000000012"
    scenario_c = "00000000-0000-4000-8000-000000000013"
    calculation_a = "00000000-0000-4000-8000-000000000021"
    calculation_b = "00000000-0000-4000-8000-000000000022"
    base_input = {"name": "base", "capital_budget": "100.00"}
    target_input = {"name": "target", "capital_budget": "100.00"}
    base = revision(
        "00000000-0000-4000-8000-000000000031",
        [scenario_a, scenario_b],
        [calculation_a],
        75,
        "90.00",
        base_input,
    )
    target = revision(
        "00000000-0000-4000-8000-000000000032",
        [scenario_b, scenario_c],
        [calculation_b],
        80.5,
        "85.00",
        target_input,
    )

    result = program_revision_diff(base, target)

    assert result["added_scenario_revision_ids"] == [scenario_c]
    assert result["removed_scenario_revision_ids"] == [scenario_a]
    assert result["added_calculation_snapshot_ids"] == [calculation_b]
    assert result["removed_calculation_snapshot_ids"] == [calculation_a]
    assert result["changed_input_fields"] == ["name"]
    assert result["objective_delta"] == 5.5
    assert result["capital_delta"] == "-5.00"
    # The deliberately small input snapshots above exercise the pure delta helper only;
    # endpoint coverage validates the complete canonical response.
