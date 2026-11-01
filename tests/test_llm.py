import json

import httpx
import pytest
from pydantic import SecretStr, ValidationError

from services.api.config import Settings
from services.api.llm import (
    GeminiProvider,
    LLMGateway,
    LLMReply,
    LLMRequest,
    Message,
    OllamaProvider,
    OpenAIProvider,
    ProviderRejected,
    ProviderUnavailable,
    ToolSpec,
    Usage,
    gateway,
)


def config(**values):
    defaults = {
        "database_url": SecretStr("postgresql+psycopg://test:test@localhost/test"),
        "environment": "test",
        "token_encryption_key": SecretStr("W6GIperyIRMNAALFYmW30mhMrs1N73wueAfchMsdCuE="),
        "llm_provider": "disabled",
    }
    return Settings(_env_file=None, **(defaults | values))


def request():
    return LLMRequest(
        messages=(Message("system", "Use tools."), Message("user", "Status?")),
        tools=(
            ToolSpec(
                "get_status",
                "Read bounded status",
                {"type": "object", "properties": {}, "additionalProperties": False},
            ),
        ),
    )


def test_openai_provider_parses_allowlisted_tool_without_leaking_key():
    seen = {}

    def handler(call):
        seen["authorization"] = call.headers["Authorization"]
        seen["body"] = json.loads(call.content)
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": "safe-call",
                                    "function": {
                                        "name": "get_status",
                                        "arguments": "{}",
                                    },
                                }
                            ],
                        }
                    }
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 3},
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    provider = OpenAIProvider(
        "openrouter", "https://example.test/v1", "test-model", "SECRET", config(), client
    )
    reply = provider.complete(request())
    assert reply.tool_calls[0].name == "get_status"
    assert reply.usage.input_tokens == 10
    assert seen["authorization"] == "Bearer SECRET"
    assert seen["body"]["max_tokens"] == 800
    assert "SECRET" not in repr(reply)


def test_unknown_tool_and_invalid_arguments_are_rejected():
    for function in [
        {"name": "delete_everything", "arguments": "{}"},
        {"name": "get_status", "arguments": "[]"},
    ]:
        client = httpx.Client(
            transport=httpx.MockTransport(
                lambda call, function=function: httpx.Response(
                    200,
                    json={
                        "choices": [
                            {"message": {"content": "", "tool_calls": [{"function": function}]}}
                        ]
                    },
                )
            )
        )
        provider = OpenAIProvider(
            "openrouter", "https://example.test/v1", "test-model", "SECRET", config(), client
        )
        with pytest.raises(ProviderRejected):
            provider.complete(request())


def test_gateway_falls_back_only_for_unavailable_provider():
    class Fails:
        def __init__(self, error):
            self.error = error

        def complete(self, value):
            raise self.error("safe_code")

    class Works:
        def complete(self, value):
            return "fallback"

    assert LLMGateway([Fails(ProviderUnavailable), Works()]).complete(request()) == "fallback"
    with pytest.raises(ProviderRejected):
        LLMGateway([Fails(ProviderRejected), Works()]).complete(request())


def test_gateway_retries_one_empty_reply_before_showing_it():
    class EmptyOnce:
        calls = 0

        def complete(self, value):
            self.calls += 1
            text = "Готово" if self.calls == 2 else ""
            return LLMReply("openrouter", "free", text, (), Usage(None, None))

    provider = EmptyOnce()
    assert LLMGateway([provider]).complete(request()).text == "Готово"
    assert provider.calls == 2


def test_gemini_safety_refusal_is_rejected_without_provider_details():
    client = httpx.Client(
        transport=httpx.MockTransport(
            lambda call: httpx.Response(
                200,
                json={
                    "candidates": [
                        {"finishReason": "SAFETY", "content": {"parts": [{"text": ""}]}}
                    ]
                },
            )
        )
    )
    provider = GeminiProvider("gemini", "test-model", "SECRET", config(), client)
    with pytest.raises(ProviderRejected, match="llm_provider_refused") as raised:
        provider.complete(request())
    assert "SECRET" not in repr(raised.value)


def test_request_bounds_are_enforced_before_transport():
    too_large = LLMRequest(messages=(Message("user", "x" * 50_001),))
    with pytest.raises(ProviderRejected, match="llm_request_too_large"):
        LLMGateway([object()]).complete(too_large)


def test_configuration_rejects_unknown_duplicate_and_unsafe_bounds():
    with pytest.raises(ValidationError, match="Invalid LLM provider"):
        config(llm_provider="unknown")
    with pytest.raises(ValidationError, match="unique"):
        config(llm_provider="gemini", llm_fallback_providers="gemini")
    with pytest.raises(ValidationError, match="timeout"):
        config(llm_timeout_seconds=0)
    with pytest.raises(ValidationError, match="Disabled"):
        config(llm_fallback_providers="gemini")
    with pytest.raises(ValidationError, match="OpenRouter model"):
        config(llm_provider="openrouter", llm_model="")


def test_gateway_uses_only_configured_providers_with_keys():
    value = config(
        llm_provider="openrouter",
        llm_model="free-model",
        llm_fallback_providers="gemini,groq",
        openrouter_api_key=SecretStr("OR"),
        gemini_api_key=SecretStr("GM"),
    )
    built = gateway(value, httpx.Client(transport=httpx.MockTransport(lambda call: None)))
    assert [item.name for item in built.providers] == ["openrouter", "gemini"]


def test_local_provider_is_loopback_and_non_production_only():
    local = config(llm_provider="local", llm_local_base_url="http://127.0.0.1:8019/v1")
    provider = gateway(local).providers[0]
    assert provider.name == "local" and provider.base_url == "http://127.0.0.1:8019"
    for url in ("", "https://127.0.0.1:8019/v1", "http://example.com:80/v1", "http://10.0.0.1:80"):
        with pytest.raises(ValidationError, match="loopback-only"):
            config(llm_provider="local", llm_local_base_url=url)
    with pytest.raises(ValidationError, match="loopback-only"):
        config(
            llm_provider="local",
            llm_local_base_url="http://127.0.0.1:8019/v1",
            environment="production",
            cookie_secure=True,
            public_origin="https://green.example",
            oidc_issuer="https://id.example/realms/pavlodar",
        )


def test_local_ollama_disables_thinking_and_parses_native_reply():
    seen = {}

    def handler(call):
        seen["path"] = call.url.path
        seen["body"] = json.loads(call.content)
        return httpx.Response(
            200,
            json={
                "message": {"role": "assistant", "content": "Готово", "tool_calls": []},
                "prompt_eval_count": 12,
                "eval_count": 3,
            },
        )

    provider = OllamaProvider(
        "local",
        "http://127.0.0.1:11434/v1",
        "qwen3.5:4b-q4_K_M",
        config(),
        httpx.Client(transport=httpx.MockTransport(handler)),
    )
    reply = provider.complete(request())
    assert reply.text == "Готово"
    assert reply.usage.output_tokens == 3
    assert seen["path"] == "/api/chat"
    assert seen["body"]["think"] is False
