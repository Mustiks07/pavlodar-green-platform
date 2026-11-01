import pytest
from sqlalchemy import select, text

from packages.domain.contracts import validate
from services.api.chat import (
    grounded_fallback_reply,
    latest_calculation_context,
    presentable_reply,
    snapshot_facts,
)
from services.api.db import engine, session
from services.api.llm import LLMReply, LLMRequest, Message, ToolCall, Usage
from services.api.models import ChatMessageRecord
from services.worker.main import run_job
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

    class ProposalGateway:
        def complete(self, request):
            assert [tool.name for tool in request.tools] == ["propose_placement_quantity"]
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
