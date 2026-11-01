import copy
import json
from pathlib import Path

import pytest

from services.api.chat import (
    proposal_tool_available,
    validate_quantity_proposal_arguments,
)

CASES = json.loads(
    (Path(__file__).parent / "fixtures/chat_adversarial_cases.json").read_text(encoding="utf-8")
)


def _arguments(case):
    value = copy.deepcopy(case["input"])
    if isinstance(value, dict) and "summary_repeat" in value:
        value["summary"] = "x" * value.pop("summary_repeat")
    return value


def _scenario(case):
    value = copy.deepcopy(case["scenario"])
    if not isinstance(value, dict):
        return value
    if "placement_locks" in value:
        value["placements"] = [
            {"id": f"placement-{index}", "locked": locked}
            for index, locked in enumerate(value.pop("placement_locks"))
        ]
    if "repeat_locked" in value:
        value["placements"] = [
            {"id": f"placement-{index}", "locked": True}
            for index in range(value.pop("repeat_locked"))
        ]
        if value.pop("append_unlocked", False):
            value["placements"].append({"id": "unlocked", "locked": False})
    return value


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["id"])
def test_adversarial_chat_policy(case):
    if case["kind"] == "arguments":
        if case["valid"]:
            summary, placement_id, quantity = validate_quantity_proposal_arguments(
                _arguments(case)
            )
            assert summary
            assert placement_id
            assert 1 <= quantity <= 100_000
        else:
            with pytest.raises(ValueError, match=f"^{case['error']}$"):
                validate_quantity_proposal_arguments(_arguments(case))
    else:
        assert case["kind"] == "availability"
        assert (
            proposal_tool_available(case["revision_id"], _scenario(case))
            is case["available"]
        )


def test_adversarial_set_is_bounded_unique_and_substantial():
    assert len(CASES) >= 50
    assert len({case["id"] for case in CASES}) == len(CASES)
    assert {case["kind"] for case in CASES} == {"arguments", "availability"}
    assert sum(case["kind"] == "arguments" for case in CASES) >= 25
    assert sum(case["kind"] == "availability" for case in CASES) >= 20
