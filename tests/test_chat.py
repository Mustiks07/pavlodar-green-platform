import pytest
from sqlalchemy import select, text

from packages.domain.contracts import validate
from services.api.chat import (
    grounded_fallback_reply,
    latest_calculation_context,
    presentable_reply,
    server_owned_tool_reply,
    snapshot_facts,
)
from services.api.config import settings
from services.api.db import engine, session
from services.api.llm import LLMReply, LLMRequest, Message, ToolCall, ToolSpec, Usage
from services.api.models import (
    CalculationSnapshotRecord,
    ChatMessageRecord,
    ExportArtifactRecord,
    Job,
)
from services.worker.main import run_job
from tests.test_calculations import setup_revision
from tests.test_catalog import (
    RULE_ID,
    create_three_plants,
    publish_catalog_source,
    publish_rule,
    school_zone,
)
from tests.test_foundation import create_zone, mutation, revision_body
from tools.dev.seed import CITY_ID

pytestmark = pytest.mark.integration


def test_latest_calculation_context_uses_canonical_cost_fields():
    context = latest_calculation_context(
        "99000000-0000-4000-8000-000000000099",
        {
            "status": "partial",
            "cost": {
                "known_subtotal": "125.50",
                "total": None,
                "lines": [
                    {
                        "category": "material",
                        "quantity": 2,
                        "unit": "piece",
                        "unit_price": "50.00",
                        "subtotal": "100.00",
                        "year": None,
                    }
                ],
                "data_gaps": [{"code": "missing_rate"}],
            },
            "survival": [
                {
                    "placement_id": "p1",
                    "model_kind": "expert_rules",
                    "calibration_status": "uncalibrated",
                    "points": [{"year": 1, "probability": 0.8}],
                    "risks": [],
                    "data_gaps": [],
                }
            ],
            "care": [{"month": 5, "year_offset": 0, "operation": "полив", "quantity": 1}],
            "ecosystem": [
                {
                    "key": "green_area",
                    "value": 12.5,
                    "unit": "m2",
                    "horizon_year": 5,
                    "status": "synthetic",
                    "lower": None,
                    "upper": None,
                    "qualitative_confidence": "low",
                }
            ],
            "warnings": [{"code": "missing_rate"}],
        },
    )
    assert context == {
        "id": "99000000-0000-4000-8000-000000000099",
        "status": "partial",
        "known_total_kzt": "125.50",
        "full_total_kzt": None,
        "cost_lines": [
            {
                "category": "material",
                "quantity": 2,
                "unit": "piece",
                "unit_price": "50.00",
                "subtotal": "100.00",
                "year": None,
            }
        ],
        "cost_gap_codes": ["missing_rate"],
        "survival": [
            {
                "placement_id": "p1",
                "model_kind": "expert_rules",
                "calibration_status": "uncalibrated",
                "points": [{"year": 1, "probability": 0.8}],
                "risks": [],
                "data_gap_codes": [],
            }
        ],
        "care": [
            {
                "month": 5,
                "year_offset": 0,
                "operation": "полив",
                "quantity": 1,
                "unit": None,
                "water_m3": None,
                "crew_minutes": None,
                "visits": None,
            }
        ],
        "ecosystem": [
            {
                "key": "green_area",
                "value": 12.5,
                "unit": "m2",
                "horizon_year": 5,
                "status": "synthetic",
                "lower": None,
                "upper": None,
                "qualitative_confidence": "low",
            }
        ],
        "warning_codes": ["missing_rate"],
    }


def test_snapshot_facts_keep_exact_survival_lineage():
    facts = snapshot_facts(
        "99000000-0000-4000-8000-000000000099",
        "99000000-0000-4000-8000-000000000098",
        {
            "survival": [
                {
                    "model_kind": "expert_rules",
                    "calibration_status": "uncalibrated",
                    "points": [{"year": 1, "probability": 0.88, "lower": 0.78, "upper": 0.94}],
                    "risks": [
                        {
                            "source_refs": [
                                {
                                    "dataset_version_id": "99000000-0000-4000-8000-000000000097",
                                    "source_record_id": "survival-v1",
                                    "label": "Оценочный профиль приживаемости",
                                    "uri": None,
                                }
                            ]
                        }
                    ],
                }
            ]
        },
    )
    assert len(facts) == 1
    fact = facts[0]
    validate("Fact", fact)
    assert fact["metric"]["value"] == 0.88
    assert fact["metric"]["lower"] == 0.78
    assert fact["metric"]["source_refs"][0]["source_record_id"] == "survival-v1"
    assert fact["calculation_id"] == "99000000-0000-4000-8000-000000000099"
    assert fact["scenario_revision_id"] == "99000000-0000-4000-8000-000000000098"


def test_grounded_fallback_uses_only_authorized_context():
    context = {
        "city": {"name": "Павлодар"},
        "zone": {"area_m2": 1250.4, "purpose": "courtyard"},
        "latest_calculation": {"status": "complete", "full_total_kzt": "450000.00"},
        "problems": [{"severity": "high", "description": "дефицит зелени"}],
        "priority": {"zones": [{"zone_name": "Двор", "score": 0.82}]},
    }
    reply = grounded_fallback_reply(
        LLMRequest(
            messages=(
                Message("system", "rules"),
                Message("system", "AUTHORIZED_CONTEXT=" + __import__("json").dumps(context)),
                Message("user", "Что делать?"),
            )
        )
    )
    assert reply.provider == "grounded-fallback"
    assert "1 250 м²" in reply.text
    assert "450000.00 ₸" in reply.text
    assert "дефицит зелени" in reply.text
    assert "Двор — 82/100" in reply.text
    assert not reply.tool_calls


def test_grounded_fallback_accepts_priority_score_already_on_100_scale():
    context = {"city": {"name": "Павлодар"}, "priority": {"zones": [{"zone_name": "Сквер", "score": 72.5}]}}
    reply = grounded_fallback_reply(
        LLMRequest(
            messages=(
                Message("system", "rules"),
                Message("system", "AUTHORIZED_CONTEXT=" + __import__("json").dumps(context)),
                Message("user", "Что делать?"),
            )
        )
    )
    assert "Сквер — 72/100" in reply.text
    assert "7250/100" not in reply.text


def test_raw_provider_context_is_replaced_with_presentable_server_summary():
    context = {
        "city": {"name": "Павлодар"},
        "latest_calculation": {
            "status": "complete",
            "full_total_kzt": "450000.00",
            "survival": [
                {"points": [{"year": 1, "probability": 0.88}]},
                {"points": [{"year": 1, "probability": 0.88}]},
            ],
        },
    }
    request = LLMRequest(
        messages=(
            Message("system", "rules"),
            Message("system", "AUTHORIZED_CONTEXT=" + __import__("json").dumps(context)),
            Message("user", "Какова приживаемость?"),
        )
    )
    raw = LLMReply(
        provider="test-provider",
        model="test-model",
        text='survival.points probability для placement_id 99000000-0000-4000-8000-000000000001',
        tool_calls=(),
        usage=Usage(input_tokens=10, output_tokens=5),
    )
    cleaned = presentable_reply(request, raw)
    assert cleaned.provider == raw.provider
    assert "приживаемость через 1 год — 88% для 2 групп" in cleaned.text
    assert "placement_id" not in cleaned.text
    assert "99000000" not in cleaned.text


def test_provider_number_without_server_fact_is_replaced():
    context = {
        "city": {"name": "Павлодар"},
        "latest_calculation": {
            "status": "complete",
            "survival": [{"points": [{"year": 1, "probability": 0.88}]}],
        },
    }
    request = LLMRequest(
        messages=(
            Message("system", "rules"),
            Message("system", "AUTHORIZED_CONTEXT=" + __import__("json").dumps(context)),
            Message("user", "Какова приживаемость?"),
        )
    )
    facts = snapshot_facts(
        "99000000-0000-4000-8000-000000000099",
        "99000000-0000-4000-8000-000000000098",
        {
            "survival": [
                {
                    "model_kind": "expert_rules",
                    "calibration_status": "uncalibrated",
                    "points": [{"year": 1, "probability": 0.88}],
                    "risks": [],
                }
            ]
        },
    )
    raw = LLMReply(
        provider="test-provider",
        model="test-model",
        text="Приживаемость составит 99% через 1 год.",
        tool_calls=(),
        usage=Usage(input_tokens=10, output_tokens=8),
    )
    cleaned = presentable_reply(request, raw, facts)
    assert "99%" not in cleaned.text
    assert "88%" in cleaned.text


def test_provider_exact_value_with_wrong_unit_is_replaced():
    context = {"city": {"name": "Павлодар"}, "zone": {"area_m2": 1250, "purpose": "двор"}}
    request = LLMRequest(
        messages=(
            Message("system", "rules"),
            Message("system", "AUTHORIZED_CONTEXT=" + __import__("json").dumps(context)),
            Message("user", "Какова площадь?"),
        )
    )
    facts = [
        {
            "id": "99000000-0000-4000-8000-000000000010",
            "label": "Площадь участка",
            "metric": {
                "key": "zone_area",
                "value": 1250,
                "unit": "m2",
                "horizon_year": None,
                "status": "estimated",
                "lower": None,
                "upper": None,
                "qualitative_confidence": "medium",
                "method_version": "area-v1",
                "source_refs": [],
                "missing_reason": None,
            },
            "calculation_id": None,
            "scenario_revision_id": None,
        }
    ]
    raw = LLMReply(
        provider="test-provider",
        model="test-model",
        text="Площадь участка — 1 250 кг.",
        tool_calls=(),
        usage=Usage(input_tokens=10, output_tokens=8),
    )
    cleaned = presentable_reply(request, raw, facts)
    assert "кг" not in cleaned.text
    assert "1 250 м²" in cleaned.text


def test_provider_exact_fact_numbers_and_numbered_list_are_kept():
    request = LLMRequest(messages=(Message("system", "rules"), Message("user", "Результат?")))
    facts = snapshot_facts(
        "99000000-0000-4000-8000-000000000099",
        "99000000-0000-4000-8000-000000000098",
        {
            "cost": {"total": "450000.00"},
            "survival": [
                {
                    "model_kind": "expert_rules",
                    "calibration_status": "uncalibrated",
                    "points": [{"year": 1, "probability": 0.88}],
                    "risks": [],
                }
            ],
        },
    )
    raw = LLMReply(
        provider="test-provider",
        model="test-model",
        text="1. Приживаемость — 88% через 1 год.\n2. Стоимость — 450 000 ₸.",
        tool_calls=(),
        usage=Usage(input_tokens=10, output_tokens=12),
    )
    assert presentable_reply(request, raw, facts) == raw
    assert len(facts) == 2
    for fact in facts:
        validate("Fact", fact)


def test_tool_reply_keeps_validated_quantity_but_removes_unbacked_metric():
    request = LLMRequest(messages=(Message("system", "rules"), Message("user", "Измени")))
    raw = LLMReply(
        provider="test-provider",
        model="test-model",
        text="Увеличу до 3, это даст 99% приживаемости.",
        tool_calls=(
            ToolCall(
                "call-1",
                "propose_placement_quantity",
                {
                    "summary": "Увеличить количество",
                    "placement_id": "99000000-0000-4000-8000-000000000001",
                    "quantity": 3,
                },
            ),
        ),
        usage=Usage(input_tokens=10, output_tokens=10),
    )
    cleaned = presentable_reply(request, raw)
    assert cleaned.tool_calls == raw.tool_calls
    assert "99%" not in cleaned.text
    assert "ещё не применено" in cleaned.text


def test_grounded_fallback_routes_explicit_plant_selection_to_server_tool():
    request = LLMRequest(
        messages=(Message("system", "rules"), Message("user", "Подбери растения для участка")),
        tools=(
            ToolSpec(
                name="recommend_plants",
                description="server recommendation",
                parameters={"type": "object"},
            ),
        ),
    )
    reply = grounded_fallback_reply(request)
    assert reply.provider == "server-tools"
    assert reply.tool_calls[0].name == "recommend_plants"
    assert reply.tool_calls[0].arguments == {"top_n": 5}


def test_server_owned_calculation_intent_is_explicit_and_argument_free():
    tool = ToolSpec(
        name="calculate_current_scenario",
        description="canonical calculation",
        parameters={"type": "object", "additionalProperties": False, "properties": {}},
    )
    explicit = server_owned_tool_reply(
        LLMRequest(
            messages=(Message("system", "rules"), Message("user", "Пересчитай текущий проект")),
            tools=(tool,),
        )
    )
    assert explicit.tool_calls[0].name == "calculate_current_scenario"
    assert explicit.tool_calls[0].arguments == {}
    explanatory = server_owned_tool_reply(
        LLMRequest(
            messages=(Message("system", "rules"), Message("user", "Как считается стоимость?")),
            tools=(tool,),
        )
    )
    assert explanatory is None


def test_server_owned_report_intent_is_explicit_and_argument_free():
    tool = ToolSpec(
        name="create_current_report",
        description="snapshot report",
        parameters={"type": "object", "additionalProperties": False, "properties": {}},
    )
    explicit = server_owned_tool_reply(
        LLMRequest(
            messages=(Message("system", "rules"), Message("user", "Сформируй PDF-отчёт")),
            tools=(tool,),
        )
    )
    assert explicit.provider == "server-tools"
    assert explicit.tool_calls[0].name == "create_current_report"
    assert explicit.tool_calls[0].arguments == {}
    explanatory = server_owned_tool_reply(
        LLMRequest(
            messages=(Message("system", "rules"), Message("user", "Как формируется отчёт?")),
            tools=(tool,),
        )
    )
    assert explanatory is None


@pytest.mark.parametrize(
    "question",
    [
        "Покажи результат текущего проекта",
        "Что получилось в расчёте?",
        "Покажи смету",
        "Покажи приживаемость",
        "Покажи экологический эффект",
    ],
)
def test_server_owned_current_result_intent_is_explicit_and_argument_free(question):
    tool = ToolSpec(
        name="get_current_result",
        description="frozen current result",
        parameters={"type": "object", "additionalProperties": False, "properties": {}},
    )
    explicit = server_owned_tool_reply(
        LLMRequest(
            messages=(Message("system", "rules"), Message("user", question)),
            tools=(tool,),
        )
    )
    assert explicit.provider == "server-tools"
    assert explicit.tool_calls[0].name == "get_current_result"
    assert explicit.tool_calls[0].arguments == {}

    explanatory = server_owned_tool_reply(
        LLMRequest(
            messages=(Message("system", "rules"), Message("user", "Как считается смета?")),
            tools=(tool,),
        )
    )
    assert explanatory is None


def test_chat_calculates_exact_bound_revision_without_provider_or_duplicates(clients, monkeypatch):
    scenario, _revision, saved, _rate = setup_revision(clients, with_model=True)
    revision_id = saved.json()["id"]
    specialist = clients["specialist"]
    created_chat = chat_session(specialist, scenario["zone_id"], revision_id)

    class ForbiddenGateway:
        def complete(self, request):
            raise AssertionError("explicit canonical calculation must bypass the provider")

    monkeypatch.setattr("services.api.llm.gateway", lambda: ForbiddenGateway())
    job = send(
        specialist,
        created_chat["id"],
        "Пересчитай текущий проект и покажи подтверждённые результаты",
        revision_id,
        key="assistant-fast-calculation-once",
    )
    assert send(
        specialist,
        created_chat["id"],
        "Пересчитай текущий проект и покажи подтверждённые результаты",
        revision_id,
        key="assistant-fast-calculation-once",
    ) == job
    run_job.run(job["id"])

    with session() as db:
        snapshots = list(
            db.scalars(
                select(CalculationSnapshotRecord).where(
                    CalculationSnapshotRecord.scenario_revision_id == revision_id
                )
            )
        )
    assert len(snapshots) == 1
    snapshot = snapshots[0]
    messages = specialist.get(
        f"/v1/chat/sessions/{created_chat['id']}/messages"
    ).json()["items"]
    assistant = messages[-1]
    assert assistant["state"] == "completed"
    assert "расчёт сохранён" in assistant["text"]
    assert assistant["facts"]
    calculation_facts = [fact for fact in assistant["facts"] if fact["calculation_id"]]
    assert {fact["calculation_id"] for fact in calculation_facts} == {snapshot.id}
    assert {fact["scenario_revision_id"] for fact in calculation_facts} == {revision_id}
    survival_fact = next(
        fact for fact in calculation_facts if fact["metric"]["key"] == "survival_probability"
    )
    assert survival_fact["metric"]["value"] == snapshot.payload["survival"][0]["points"][0]["probability"]


def test_chat_report_uses_latest_exact_snapshot_and_one_export_job(
    clients, monkeypatch, tmp_path
):
    monkeypatch.setattr(settings(), "export_root", str(tmp_path))
    scenario, _revision, saved, _rate = setup_revision(clients, with_model=True)
    revision_id = saved.json()["id"]
    specialist = clients["specialist"]
    created_chat = chat_session(specialist, scenario["zone_id"], revision_id)

    class ForbiddenGateway:
        def complete(self, request):
            raise AssertionError("explicit report must bypass the provider")

    monkeypatch.setattr("services.api.llm.gateway", lambda: ForbiddenGateway())
    missing_job = send(
        specialist,
        created_chat["id"],
        "Сформируй PDF-отчёт по текущему проекту",
        revision_id,
        key="assistant-report-without-snapshot",
    )
    run_job.run(missing_job["id"])
    missing_message = specialist.get(
        f"/v1/chat/sessions/{created_chat['id']}/messages"
    ).json()["items"][-1]
    validate("ChatMessage", missing_message)
    assert missing_message["report_job_id"] is None
    assert "нет сохранённого расчёта" in missing_message["text"]
    with session() as db:
        assert list(db.scalars(select(Job).where(Job.input_kind == "calculation"))) == []

    snapshots = []
    for seed in (41, 42):
        calculated = mutation(
            specialist,
            "POST",
            "/v1/calculations/fast",
            {
                "scenario_revision_id": revision_id,
                "mode": "fast",
                "include_modules": ["cost", "survival", "care", "suitability"],
                "seed": seed,
            },
            key=f"assistant-report-snapshot-{seed}",
        )
        assert calculated.status_code == 200, calculated.text
        snapshots.append(calculated.json()["snapshot"])

    report_chat_job = send(
        specialist,
        created_chat["id"],
        "Сформируй PDF-отчёт по текущему проекту",
        revision_id,
        key="assistant-report-once",
    )
    assert send(
        specialist,
        created_chat["id"],
        "Сформируй PDF-отчёт по текущему проекту",
        revision_id,
        key="assistant-report-once",
    ) == report_chat_job
    run_job.run(report_chat_job["id"])

    assistant = specialist.get(
        f"/v1/chat/sessions/{created_chat['id']}/messages"
    ).json()["items"][-1]
    validate("ChatMessage", assistant)
    assert assistant["state"] == "completed"
    assert assistant["report_job_id"]
    assert "PDF-отчёт поставлен в очередь" in assistant["text"]
    with session() as db:
        report_jobs = list(db.scalars(select(Job).where(Job.input_kind == "calculation")))
        assert len(report_jobs) == 1
        report_job = report_jobs[0]
        assert report_job.id == assistant["report_job_id"]
        assert report_job.request_payload == {
            "target_kind": "calculation",
            "target_id": snapshots[-1]["id"],
            "format": "pdf",
            "language": "ru",
        }

    run_job.run(assistant["report_job_id"])
    completed = specialist.get(f"/v1/jobs/{assistant['report_job_id']}").json()
    assert completed["state"] == "succeeded"
    with session() as db:
        artifact = db.get(ExportArtifactRecord, completed["result_ref_id"])
        assert artifact.target_kind == "calculation"
        assert artifact.target_id == snapshots[-1]["id"]
        assert artifact.format == "pdf"


def test_chat_current_result_is_latest_for_bound_revision_and_read_only(
    clients, monkeypatch
):
    scenario, revision, saved, _rate = setup_revision(clients, with_model=True)
    bound_revision_id = saved.json()["id"]
    specialist = clients["specialist"]
    created_chat = chat_session(specialist, scenario["zone_id"], bound_revision_id)

    newer_body = {
        **revision,
        "parent_revision_id": bound_revision_id,
        "placements": [
            {
                **revision["placements"][0],
                "quantity": revision["placements"][0]["quantity"] + 1,
            }
        ],
        "comment": "SYNTHETIC TEST newer revision must not replace chat binding",
    }
    newer = mutation(
        specialist,
        "POST",
        f"/v1/scenarios/{scenario['id']}/revisions",
        newer_body,
        etag=saved.headers["etag"],
    )
    assert newer.status_code == 201, newer.text
    newer_revision_id = newer.json()["id"]
    other_snapshot = mutation(
        specialist,
        "POST",
        "/v1/calculations/fast",
        {
            "scenario_revision_id": newer_revision_id,
            "mode": "fast",
            "include_modules": ["cost", "survival", "care"],
            "seed": 80,
        },
        key="assistant-current-result-other-revision",
    )
    assert other_snapshot.status_code == 200, other_snapshot.text

    class ForbiddenGateway:
        def complete(self, request):
            raise AssertionError("explicit current-result lookup must bypass the provider")

    monkeypatch.setattr("services.api.llm.gateway", lambda: ForbiddenGateway())

    # Even an overridden message revision cannot move a historical bound chat.
    missing_job = send(
        specialist,
        created_chat["id"],
        "Покажи результат текущего проекта",
        newer_revision_id,
        key="assistant-current-result-bound-missing",
    )
    run_job.run(missing_job["id"])
    missing_message = specialist.get(
        f"/v1/chat/sessions/{created_chat['id']}/messages"
    ).json()["items"][-1]
    assert "нет сохранённого расчёта" in missing_message["text"]
    assert missing_message["facts"] == []
    assert missing_message["proposal_id"] is None
    assert missing_message["report_job_id"] is None
    with session() as db:
        assert db.scalar(
            select(CalculationSnapshotRecord).where(
                CalculationSnapshotRecord.scenario_revision_id == bound_revision_id
            )
        ) is None
        assert list(db.scalars(select(Job).where(Job.input_kind == "calculation"))) == []

    for seed in (81, 82):
        calculated = mutation(
            specialist,
            "POST",
            "/v1/calculations/fast",
            {
                "scenario_revision_id": bound_revision_id,
                "mode": "fast",
                "include_modules": ["cost", "survival", "care"],
                "seed": seed,
            },
            key=f"assistant-current-result-exact-{seed}",
        )
        assert calculated.status_code == 200, calculated.text

    with session() as db:
        expected = db.scalar(
            select(CalculationSnapshotRecord)
            .where(CalculationSnapshotRecord.scenario_revision_id == bound_revision_id)
            .order_by(
                CalculationSnapshotRecord.created_at.desc(),
                CalculationSnapshotRecord.id.desc(),
            )
            .limit(1)
        )
        snapshot_count = len(list(db.scalars(select(CalculationSnapshotRecord))))

    result_job = send(
        specialist,
        created_chat["id"],
        "Что получилось в расчёте?",
        newer_revision_id,
        key="assistant-current-result-once",
    )
    assert send(
        specialist,
        created_chat["id"],
        "Что получилось в расчёте?",
        newer_revision_id,
        key="assistant-current-result-once",
    ) == result_job
    run_job.run(result_job["id"])

    assistant = specialist.get(
        f"/v1/chat/sessions/{created_chat['id']}/messages"
    ).json()["items"][-1]
    validate("ChatMessage", assistant)
    assert assistant["state"] == "completed"
    assert "точно закреплённой версии" in assistant["text"]
    assert assistant["proposal_id"] is None
    assert assistant["report_job_id"] is None
    assert assistant["facts"]
    assert {fact["calculation_id"] for fact in assistant["facts"]} == {expected.id}
    assert {fact["scenario_revision_id"] for fact in assistant["facts"]} == {
        bound_revision_id
    }
    known_cost = next(
        fact for fact in assistant["facts"] if fact["metric"]["key"] == "known_cost"
    )
    assert known_cost["metric"]["value"] == float(expected.payload["cost"]["known_subtotal"])
    survival = next(
        fact
        for fact in assistant["facts"]
        if fact["metric"]["key"] == "survival_probability"
    )
    assert survival["metric"]["value"] == expected.payload["survival"][0]["points"][0][
        "probability"
    ]
    assert specialist.get(f"/v1/scenarios/{scenario['id']}").json()[
        "current_revision_id"
    ] == newer_revision_id
    with session() as db:
        assert len(list(db.scalars(select(CalculationSnapshotRecord)))) == snapshot_count


class FakeGateway:
    def complete(self, request):
        assert "AUTHORIZED_CONTEXT=" in request.messages[1].content
        assert "площадь" in request.messages[2].content.lower()
        return LLMReply(
            provider="test-provider",
            model="test-model",
            text="Площадь участка указана в фактах ответа.",
            tool_calls=(),
            usage=Usage(input_tokens=20, output_tokens=8),
        )


def chat_session(client, zone_id=None, scenario_revision_id=None, key=None):
    response = mutation(
        client,
        "POST",
        "/v1/chat/sessions",
        {
            "city_id": CITY_ID,
            "zone_id": zone_id,
            "scenario_revision_id": scenario_revision_id,
        },
        key=key,
    )
    assert response.status_code == 201, response.text
    validate("ChatSession", response.json())
    return response.json()


def send(
    client,
    session_id,
    text_value="Какая площадь участка?",
    scenario_revision_id=None,
    key=None,
):
    response = mutation(
        client,
        "POST",
        f"/v1/chat/sessions/{session_id}/messages",
        {"text": text_value, "scenario_revision_id": scenario_revision_id},
        key=key,
    )
    assert response.status_code == 202, response.text
    validate("Job", response.json())
    return response.json()


def test_durable_chat_job_grounded_fact_access_and_cancel(clients, monkeypatch):
    specialist = clients["specialist"]
    zone = create_zone(specialist).json()
    created = chat_session(specialist, zone["id"], key="chat-session-once")
    assert chat_session(specialist, zone["id"], key="chat-session-once") == created

    assert clients["viewer"].get(
        f"/v1/chat/sessions/{created['id']}/messages"
    ).status_code == 404
    assert clients["outsider"].get(
        f"/v1/chat/sessions/{created['id']}/messages"
    ).status_code == 404

    monkeypatch.setattr("services.api.llm.gateway", lambda: FakeGateway())
    job = send(specialist, created["id"], key="chat-message-once")
    assert send(specialist, created["id"], key="chat-message-once") == job
    queued = specialist.get(f"/v1/chat/sessions/{created['id']}/messages")
    assert queued.status_code == 200, queued.text
    assert [item["state"] for item in queued.json()["items"]] == ["completed", "queued"]

    run_job.run(job["id"])
    completed_job = specialist.get(f"/v1/jobs/{job['id']}").json()
    assert completed_job["state"] == "succeeded"
    listed = specialist.get(f"/v1/chat/sessions/{created['id']}/messages")
    assert listed.status_code == 200, listed.text
    validate("ChatMessagePage", listed.json())
    assistant = listed.json()["items"][1]
    assert assistant["state"] == "completed"
    assert assistant["text"] == "Площадь участка указана в фактах ответа."
    assert assistant["facts"][0]["metric"]["key"] == "zone_area"
    assert assistant["facts"][0]["metric"]["value"] > 0
    assert completed_job["result_ref_id"] == assistant["id"]
    first_page = specialist.get(
        f"/v1/chat/sessions/{created['id']}/messages", params={"limit": 1}
    ).json()
    assert first_page["items"][0]["role"] == "user"
    second_page = specialist.get(
        f"/v1/chat/sessions/{created['id']}/messages",
        params={"limit": 1, "cursor": first_page["next_cursor"]},
    ).json()
    assert second_page["items"][0]["role"] == "assistant"

    cancelled = send(specialist, created["id"], "Отмени этот запрос")
    response = mutation(
        specialist,
        "POST",
        f"/v1/jobs/{cancelled['id']}/cancel",
        {"reason": "SYNTHETIC TEST cancellation"},
    )
    assert response.status_code == 200, response.text
    states = specialist.get(f"/v1/chat/sessions/{created['id']}/messages").json()["items"]
    assert states[-1]["state"] == "cancelled"


def test_chat_job_fails_closed_after_city_access_revocation(clients, monkeypatch):
    specialist = clients["specialist"]
    created = chat_session(specialist)
    job = send(specialist, created["id"])
    monkeypatch.setattr("services.api.llm.gateway", lambda: FakeGateway())
    with engine().begin() as conn:
        conn.execute(
            text(
                "DELETE FROM city_grants "
                "WHERE user_id='00000000-0000-4000-8000-000000000002'"
            )
        )
    run_job.run(job["id"])
    with session() as db:
        message = db.scalar(
            select(ChatMessageRecord).where(ChatMessageRecord.job_id == job["id"])
        )
        assert message.state == "failed"
        assert message.text == ""


def test_chat_requires_specialist_and_matching_city(clients):
    response = mutation(
        clients["viewer"],
        "POST",
        "/v1/chat/sessions",
        {"city_id": CITY_ID, "zone_id": None, "scenario_revision_id": None},
    )
    assert response.status_code == 403
    response = mutation(
        clients["outsider"],
        "POST",
        "/v1/chat/sessions",
        {"city_id": CITY_ID, "zone_id": None, "scenario_revision_id": None},
    )
    assert response.status_code == 404


def test_chat_proposal_requires_human_apply_and_current_revision(clients, monkeypatch):
    source_version = publish_catalog_source(clients)
    publish_rule(clients)
    plant_id, _, _ = create_three_plants(clients, source_version)
    specialist = clients["specialist"]
    catalog_id = clients["viewer"].get("/v1/plants").json()["items"][0]["version_id"]
    zone = school_zone(specialist)
    initial = revision_body(zone)
    created = mutation(
        specialist,
        "POST",
        "/v1/scenarios",
        {
            "city_id": CITY_ID,
            "zone_id": zone["id"],
            "name": "SYNTHETIC TEST proposal",
            "base_revision_id": None,
            "initial_state": initial,
        },
    )
    scenario = created.json()
    placement = {
        "id": "99000000-0000-4000-8000-000000000001",
        "plant_id": plant_id,
        "stock_item_id": None,
        "position": {"type": "Point", "coordinates": [76.9805, 52.2805]},
        "quantity": 1,
        "planting_date": "2027-05-15",
        "locked": False,
        "initial_height_m": None,
        "initial_crown_radius_m": None,
        "dimension_basis": "unknown",
    }
    saved = mutation(
        specialist,
        "POST",
        f"/v1/scenarios/{scenario['id']}/revisions",
        {
            **initial,
            "parent_revision_id": scenario["current_revision_id"],
            "catalog_version_id": catalog_id,
            "rule_version_id": RULE_ID,
            "placements": [placement],
            "comment": "SYNTHETIC TEST placement before proposal",
        },
        etag=created.headers["etag"],
    )
    assert saved.status_code == 201, saved.text
    revision_id = saved.json()["id"]
    created_chat = chat_session(specialist, zone["id"], revision_id)

    class RecommendationGateway:
        def complete(self, request):
            raise AssertionError("explicit server-owned recommendation must bypass the provider")

    monkeypatch.setattr("services.api.llm.gateway", lambda: RecommendationGateway())
    recommendation_job = send(
        specialist,
        created_chat["id"],
        "Подбери растения для этого участка",
        revision_id,
    )
    run_job.run(recommendation_job["id"])
    recommendation_message = specialist.get(
        f"/v1/chat/sessions/{created_chat['id']}/messages"
    ).json()["items"][-1]
    assert recommendation_message["proposal_id"] is None
    assert "Подбор выполнен по версии каталога и правилам текущего участка" in recommendation_message["text"]
    assert "Проект не изменён" in recommendation_message["text"]
    assert specialist.get(f"/v1/scenarios/{scenario['id']}").json()["current_revision_id"] == revision_id

    plant_proposal_job = send(
        specialist,
        created_chat["id"],
        "Подготовь замену растения на лучший вариант",
        revision_id,
    )
    run_job.run(plant_proposal_job["id"])
    plant_message = specialist.get(
        f"/v1/chat/sessions/{created_chat['id']}/messages"
    ).json()["items"][-1]
    plant_proposal_id = plant_message["proposal_id"]
    assert plant_proposal_id
    plant_proposal = specialist.get(f"/v1/proposals/{plant_proposal_id}").json()
    assert plant_proposal["status"] == "pending"
    proposed_placement = plant_proposal["proposed_revision"]["placements"][0]
    assert proposed_placement["plant_id"] != plant_id
    assert proposed_placement["quantity"] == placement["quantity"]
    assert "Заменить вид" in plant_proposal["summary"]
    assert "Заменить вид" in plant_message["text"]
    assert specialist.get(f"/v1/scenarios/{scenario['id']}").json()["current_revision_id"] == revision_id
    plant_rejected = mutation(
        specialist,
        "POST",
        f"/v1/proposals/{plant_proposal_id}/reject",
        {"reason": "Проверено в тесте перед проверкой количества"},
        key="plant-proposal-reject-once",
    )
    assert plant_rejected.status_code == 200, plant_rejected.text

    class ProposalGateway:
        def complete(self, request):
            assert [tool.name for tool in request.tools] == [
                "calculate_current_scenario",
                "create_current_report",
                "get_current_result",
                "recommend_plants",
                "propose_placement_plant",
                "propose_placement_quantity",
            ]
            return LLMReply(
                provider="test-provider",
                model="test-model",
                text="Подготовлено предложение для проверки.",
                tool_calls=(
                    ToolCall(
                        "call-1",
                        "propose_placement_quantity",
                        {
                            "summary": "Изменить количество до трёх",
                            "placement_id": placement["id"],
                            "quantity": 3,
                        },
                    ),
                ),
                usage=Usage(input_tokens=50, output_tokens=12),
            )

    monkeypatch.setattr("services.api.llm.gateway", lambda: ProposalGateway())
    job = send(
        specialist,
        created_chat["id"],
        "Измени количество в этом размещении на три",
        revision_id,
    )
    run_job.run(job["id"])
    messages = specialist.get(
        f"/v1/chat/sessions/{created_chat['id']}/messages"
    ).json()["items"]
    proposal_id = messages[-1]["proposal_id"]
    assert proposal_id
    proposal = specialist.get(f"/v1/proposals/{proposal_id}")
    assert proposal.status_code == 200, proposal.text
    validate("Proposal", proposal.json())
    assert proposal.json()["status"] == "pending"
    assert proposal.json()["proposed_revision"]["placements"][0]["quantity"] == 3
    assert (
        specialist.get(f"/v1/scenarios/{scenario['id']}").json()["current_revision_id"]
        == revision_id
    )
    assert clients["viewer"].get(f"/v1/proposals/{proposal_id}").status_code == 403

    scenario_now = specialist.get(f"/v1/scenarios/{scenario['id']}")
    wrong = mutation(
        specialist,
        "POST",
        f"/v1/proposals/{proposal_id}/apply",
        {"base_revision_id": scenario["current_revision_id"]},
        etag=scenario_now.headers["etag"],
    )
    assert wrong.status_code == 412
    applied = mutation(
        specialist,
        "POST",
        f"/v1/proposals/{proposal_id}/apply",
        {"base_revision_id": revision_id},
        etag=scenario_now.headers["etag"],
        key="proposal-apply-once",
    )
    assert applied.status_code == 201, applied.text
    validate("ScenarioRevision", applied.json())
    assert applied.json()["placements"][0]["quantity"] == 3
    assert (
        mutation(
            specialist,
            "POST",
            f"/v1/proposals/{proposal_id}/apply",
            {"base_revision_id": revision_id},
            etag=scenario_now.headers["etag"],
            key="proposal-apply-once",
        ).json()
        == applied.json()
    )
    assert specialist.get(f"/v1/proposals/{proposal_id}").json()["status"] == "applied"

    rejected_job = send(
        specialist,
        created_chat["id"],
        "Подготовь ещё одно предложение",
        applied.json()["id"],
    )
    run_job.run(rejected_job["id"])
    latest = specialist.get(
        f"/v1/chat/sessions/{created_chat['id']}/messages"
    ).json()["items"][-1]
    rejected_id = latest["proposal_id"]
    rejected = mutation(
        specialist,
        "POST",
        f"/v1/proposals/{rejected_id}/reject",
        {"reason": "SYNTHETIC TEST user rejected the suggestion"},
        key="proposal-reject-once",
    )
    assert rejected.status_code == 200, rejected.text
    assert rejected.json()["status"] == "rejected"
    assert (
        mutation(
            specialist,
            "POST",
            f"/v1/proposals/{rejected_id}/reject",
            {"reason": "SYNTHETIC TEST user rejected the suggestion"},
            key="proposal-reject-once",
        ).json()
        == rejected.json()
    )

    stale_job = send(
        specialist,
        created_chat["id"],
        "Подготовь предложение перед параллельным изменением",
        applied.json()["id"],
    )
    run_job.run(stale_job["id"])
    stale_id = specialist.get(
        f"/v1/chat/sessions/{created_chat['id']}/messages"
    ).json()["items"][-1]["proposal_id"]
    before_parallel = specialist.get(f"/v1/scenarios/{scenario['id']}")
    parallel_body = {
        key: value
        for key, value in applied.json().items()
        if key
        not in {"id", "scenario_id", "created_at", "input_hash", "synthetic_inputs"}
    }
    parallel_body["parent_revision_id"] = applied.json()["id"]
    parallel_body["comment"] = "SYNTHETIC TEST parallel user revision"
    parallel = mutation(
        specialist,
        "POST",
        f"/v1/scenarios/{scenario['id']}/revisions",
        parallel_body,
        etag=before_parallel.headers["etag"],
    )
    assert parallel.status_code == 201, parallel.text
    after_parallel = specialist.get(f"/v1/scenarios/{scenario['id']}")
    stale_apply = mutation(
        specialist,
        "POST",
        f"/v1/proposals/{stale_id}/apply",
        {"base_revision_id": applied.json()["id"]},
        etag=after_parallel.headers["etag"],
    )
    assert stale_apply.status_code == 412
    assert stale_apply.json()["current_revision_id"] == parallel.json()["id"]
    assert specialist.get(f"/v1/proposals/{stale_id}").json()["status"] == "pending"
