"""Minimal local provider smoke that never prints prompts, completions or credentials."""

import json

from services.api.config import settings
from services.api.llm import LLMError, LLMRequest, Message, ToolSpec, gateway


def main():
    config = settings()
    if config.environment not in {"development", "test"}:
        raise SystemExit("LLM smoke is disabled outside development/test")
    request = LLMRequest(
        messages=(
            Message("system", "This is a local transport test. Use the status tool."),
            Message("user", "Return the test status."),
        ),
        tools=(
            ToolSpec(
                "get_test_status",
                "Return a synthetic local smoke status",
                {"type": "object", "properties": {}, "additionalProperties": False},
            ),
        ),
    )
    failures = []
    reply = None
    for provider in gateway(config).providers:
        try:
            reply = provider.complete(request)
            break
        except LLMError as error:
            failures.append(
                {"provider": provider.name, "code": error.code, "status": error.status}
            )
    if reply is None:
        print(json.dumps({"passed": False, "failures": failures}, indent=2))
        raise SystemExit(1)
    print(
        json.dumps(
            {
                "provider": reply.provider,
                "model": reply.model,
                "tool_call_count": len(reply.tool_calls),
                "input_tokens": reply.usage.input_tokens,
                "output_tokens": reply.usage.output_tokens,
                "completion_text_redacted": True,
                "failed_providers_before_success": failures,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
