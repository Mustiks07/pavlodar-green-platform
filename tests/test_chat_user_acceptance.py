import json
from pathlib import Path

import pytest

from services.api.chat import presentable_reply
from services.api.llm import LLMReply, LLMRequest, Message, Usage

CASES = json.loads(
    (Path(__file__).parent / "fixtures/chat_user_acceptance_cases.json").read_text(encoding="utf-8")
)
CONTEXT = {
    "city": {"name": "Павлодар"},
    "zone": {"area_m2": 1250, "purpose": "двор"},
    "latest_calculation": {
        "status": "complete",
        "full_total_kzt": 450000,
        "survival": [{"points": [{"year": 1, "probability": 0.88}]}],
    },
    "priority": {"zones": [{"zone_name": "Двор", "score": 80}]},
}


def metric_fact(fact_id, label, key, value, unit, horizon=None, lower=None, upper=None):
    return {
        "id": fact_id,
        "label": label,
        "metric": {
            "key": key,
            "value": value,
            "unit": unit,
            "horizon_year": horizon,
            "status": "estimated",
            "lower": lower,
            "upper": upper,
            "qualitative_confidence": "medium",
            "method_version": "acceptance-v1",
            "source_refs": [],
            "missing_reason": None,
        },
        "calculation_id": "99000000-0000-4000-8000-000000000090",
        "scenario_revision_id": "99000000-0000-4000-8000-000000000091",
    }


FACTS = [
    metric_fact("99000000-0000-4000-8000-000000000001", "Площадь", "zone_area", 1250, "m2"),
    metric_fact("99000000-0000-4000-8000-000000000002", "Стоимость", "full_cost", 450000, "KZT"),
    metric_fact(
        "99000000-0000-4000-8000-000000000003",
        "Приживаемость",
        "survival_probability",
        0.88,
        "1",
        horizon=1,
        lower=0.78,
        upper=0.94,
    ),
    metric_fact("99000000-0000-4000-8000-000000000004", "Приоритет", "priority_score", 80, "score_100"),
]


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["id"])
def test_fixed_user_task_set(case):
    request = LLMRequest(
        messages=(
            Message("system", "rules"),
            Message(
                "system",
                "AUTHORIZED_CONTEXT=" + json.dumps(CONTEXT, ensure_ascii=False),
            ),
            Message("user", case["question"]),
        )
    )
    provider = LLMReply(
        provider="deterministic-acceptance-provider",
        model="fixed-response-v1",
        text=case["reply"],
        tool_calls=(),
        usage=Usage(input_tokens=20, output_tokens=10),
    )
    result = presentable_reply(request, provider, FACTS)
    assert (result.text == provider.text) is case["kept"]
    assert result.provider == provider.provider


def test_user_task_set_covers_required_acceptance_categories():
    assert len(CASES) >= 40
    assert len({case["id"] for case in CASES}) == len(CASES)
    assert {case["category"] for case in CASES} == {
        "correct",
        "missing_inputs",
        "wrong_units",
        "hidden_or_other_scope",
        "malicious_context",
        "revision_conflict",
        "timeout",
    }
    assert all(case["question"].strip() and case["reply"].strip() for case in CASES)
