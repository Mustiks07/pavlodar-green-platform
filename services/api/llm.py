"""Bounded, provider-neutral LLM transport.

Provider output is untrusted. This module only performs transport and structural parsing;
authorization, retrieval and tool execution stay in the chat use case.
"""

import json
import re
from dataclasses import dataclass
from typing import Any

import httpx

from services.api.config import Settings, settings

MAX_MESSAGES = 32
MAX_INPUT_CHARS = 50_000
MAX_TOOLS = 12
MAX_TOOL_SCHEMA_CHARS = 20_000
MAX_TOOL_ARGUMENT_CHARS = 20_000
TOOL_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}")


class LLMError(Exception):
    """Secret-free base error safe for internal status mapping."""

    def __init__(self, code, provider=None, status=None):
        super().__init__(code)
        self.code = code
        self.provider = provider
        self.status = status


class ProviderUnavailable(LLMError):
    pass


class ProviderRejected(LLMError):
    pass


@dataclass(frozen=True)
class Message:
    role: str
    content: str


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class Usage:
    input_tokens: int | None
    output_tokens: int | None


@dataclass(frozen=True)
class LLMReply:
    provider: str
    model: str
    text: str
    tool_calls: tuple[ToolCall, ...]
    usage: Usage


@dataclass(frozen=True)
class LLMRequest:
    messages: tuple[Message, ...]
    tools: tuple[ToolSpec, ...] = ()


def validate_request(request):
    if not 1 <= len(request.messages) <= MAX_MESSAGES:
        raise ProviderRejected("llm_request_invalid")
    if any(message.role not in {"system", "user", "assistant", "tool"} for message in request.messages):
        raise ProviderRejected("llm_request_invalid")
    if any(not isinstance(message.content, str) for message in request.messages):
        raise ProviderRejected("llm_request_invalid")
    if sum(len(message.content) for message in request.messages) > MAX_INPUT_CHARS:
        raise ProviderRejected("llm_request_too_large")
    if len(request.tools) > MAX_TOOLS:
        raise ProviderRejected("llm_request_too_large")
    names = set()
    for tool in request.tools:
        if not TOOL_NAME.fullmatch(tool.name) or tool.name in names:
            raise ProviderRejected("llm_tool_invalid")
        names.add(tool.name)
        if not tool.description or len(tool.description) > 1000:
            raise ProviderRejected("llm_tool_invalid")
        try:
            encoded = json.dumps(tool.parameters, sort_keys=True, separators=(",", ":"))
        except (TypeError, ValueError) as error:
            raise ProviderRejected("llm_tool_invalid") from error
        if len(encoded) > MAX_TOOL_SCHEMA_CHARS or tool.parameters.get("type") != "object":
            raise ProviderRejected("llm_tool_invalid")


def _token_count(value):
    return (
        value
        if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 100_000_000
        else None
    )


def _arguments(value):
    if not isinstance(value, str) or len(value) > MAX_TOOL_ARGUMENT_CHARS:
        raise ProviderRejected("llm_response_invalid")
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as error:
        raise ProviderRejected("llm_response_invalid") from error
    if not isinstance(parsed, dict):
        raise ProviderRejected("llm_response_invalid")
    return parsed


class Provider:
    def __init__(self, name, model, api_key, config, client=None):
        self.name = name
        self.model = model
        self.api_key = api_key
        self.config = config
        self.client = client or httpx.Client(timeout=config.llm_timeout_seconds)

    def _post(self, url, headers, payload):
        try:
            response = self.client.post(url, headers=headers, json=payload)
        except (httpx.TimeoutException, httpx.NetworkError) as error:
            raise ProviderUnavailable("llm_provider_unavailable", self.name) from error
        if response.status_code in {401, 403, 404, 408, 409, 429} or response.status_code >= 500:
            raise ProviderUnavailable("llm_provider_unavailable", self.name, response.status_code)
        if response.status_code >= 400:
            raise ProviderRejected("llm_provider_rejected", self.name, response.status_code)
        try:
            value = response.json()
        except (ValueError, json.JSONDecodeError) as error:
            raise ProviderUnavailable("llm_provider_invalid_response", self.name) from error
        if not isinstance(value, dict):
            raise ProviderUnavailable("llm_provider_invalid_response", self.name)
        return value

    def complete(self, request):
        raise NotImplementedError


class OpenAIProvider(Provider):
    def __init__(self, name, base_url, model, api_key, config, client=None):
        super().__init__(name, model, api_key, config, client)
        self.base_url = base_url.rstrip("/")

    def complete(self, request):
        payload = {
            "model": self.model,
            "messages": [message.__dict__ for message in request.messages],
            "temperature": 0,
            "max_tokens": self.config.llm_max_output_tokens,
        }
        if request.tools:
            payload["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters,
                    },
                }
                for tool in request.tools
            ]
            payload["tool_choice"] = "auto"
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        if self.name == "openrouter":
            headers.update({"HTTP-Referer": "http://localhost", "X-Title": "Pavlodar Green"})
        value = self._post(f"{self.base_url}/chat/completions", headers, payload)
        try:
            message = value["choices"][0]["message"]
        except (KeyError, IndexError, TypeError) as error:
            raise ProviderUnavailable("llm_provider_invalid_response") from error
        text = message.get("content") or ""
        if not isinstance(text, str):
            raise ProviderUnavailable("llm_provider_invalid_response")
        calls = []
        allowed = {tool.name for tool in request.tools}
        for index, item in enumerate(message.get("tool_calls") or []):
            try:
                function = item["function"]
                name = function["name"]
                call_id = item.get("id") or f"call-{index + 1}"
            except (KeyError, TypeError) as error:
                raise ProviderRejected("llm_response_invalid") from error
            if not isinstance(name, str) or not TOOL_NAME.fullmatch(name) or name not in allowed:
                raise ProviderRejected("llm_tool_not_allowed")
            calls.append(ToolCall(call_id, name, _arguments(function.get("arguments"))))
        usage = value.get("usage") or {}
        return LLMReply(
            self.name,
            self.model,
            text,
            tuple(calls),
            Usage(
                _token_count(usage.get("prompt_tokens")),
                _token_count(usage.get("completion_tokens")),
            ),
        )


class OllamaProvider(Provider):
    """Native Ollama transport with thinking disabled for bounded interactive latency."""

    def __init__(self, name, base_url, model, config, client=None):
        super().__init__(name, model, "local", config, client)
        self.base_url = base_url.rstrip("/").removesuffix("/v1")

    def complete(self, request):
        payload = {
            "model": self.model,
            "messages": [message.__dict__ for message in request.messages],
            "stream": False,
            "think": False,
            "options": {
                "temperature": 0,
                "num_predict": self.config.llm_max_output_tokens,
            },
        }
        if request.tools:
            payload["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters,
                    },
                }
                for tool in request.tools
            ]
        value = self._post(f"{self.base_url}/api/chat", {"Content-Type": "application/json"}, payload)
        message = value.get("message")
        if not isinstance(message, dict) or not isinstance(message.get("content", ""), str):
            raise ProviderUnavailable("llm_provider_invalid_response", self.name)
        calls = []
        allowed = {tool.name for tool in request.tools}
        for index, item in enumerate(message.get("tool_calls") or []):
            try:
                function = item["function"]
                name = function["name"]
                arguments = function.get("arguments")
            except (KeyError, TypeError) as error:
                raise ProviderRejected("llm_response_invalid", self.name) from error
            if not isinstance(name, str) or not TOOL_NAME.fullmatch(name) or name not in allowed:
                raise ProviderRejected("llm_tool_not_allowed", self.name)
            if isinstance(arguments, str):
                arguments = _arguments(arguments)
            if not isinstance(arguments, dict) or len(json.dumps(arguments, separators=(",", ":"))) > MAX_TOOL_ARGUMENT_CHARS:
                raise ProviderRejected("llm_response_invalid", self.name)
            calls.append(ToolCall(f"call-{index + 1}", name, arguments))
        return LLMReply(
            self.name,
            self.model,
            message.get("content", ""),
            tuple(calls),
            Usage(
                _token_count(value.get("prompt_eval_count")),
                _token_count(value.get("eval_count")),
            ),
        )


class GeminiProvider(Provider):
    def complete(self, request):
        system = "\n\n".join(item.content for item in request.messages if item.role == "system")
        contents = []
        for item in request.messages:
            if item.role == "system":
                continue
            role = "model" if item.role == "assistant" else "user"
            contents.append({"role": role, "parts": [{"text": item.content}]})
        payload = {
            "contents": contents,
            "generationConfig": {
                "temperature": 0,
                "maxOutputTokens": self.config.llm_max_output_tokens,
            },
        }
        if system:
            payload["systemInstruction"] = {"parts": [{"text": system}]}
        if request.tools:
            payload["tools"] = [
                {
                    "functionDeclarations": [
                        {
                            "name": tool.name,
                            "description": tool.description,
                            "parametersJsonSchema": tool.parameters,
                        }
                        for tool in request.tools
                    ]
                }
            ]
        value = self._post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent",
            {"x-goog-api-key": self.api_key, "Content-Type": "application/json"},
            payload,
        )
        try:
            candidate = value["candidates"][0]
            parts = candidate["content"]["parts"]
        except (KeyError, IndexError, TypeError) as error:
            raise ProviderUnavailable("llm_provider_invalid_response") from error
        if candidate.get("finishReason") in {"SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST"}:
            raise ProviderRejected("llm_provider_refused")
        texts, calls = [], []
        allowed = {tool.name for tool in request.tools}
        for index, part in enumerate(parts):
            if not isinstance(part, dict):
                raise ProviderRejected("llm_response_invalid")
            if isinstance(part.get("text"), str):
                texts.append(part["text"])
            if "functionCall" in part:
                call = part["functionCall"]
                name, arguments = call.get("name"), call.get("args")
                if not isinstance(name, str) or not TOOL_NAME.fullmatch(name) or name not in allowed:
                    raise ProviderRejected("llm_tool_not_allowed")
                if not isinstance(arguments, dict):
                    raise ProviderRejected("llm_response_invalid")
                if len(json.dumps(arguments, separators=(",", ":"))) > MAX_TOOL_ARGUMENT_CHARS:
                    raise ProviderRejected("llm_response_invalid")
                calls.append(ToolCall(f"call-{index + 1}", name, arguments))
        usage = value.get("usageMetadata") or {}
        return LLMReply(
            self.name,
            self.model,
            "\n".join(texts),
            tuple(calls),
            Usage(
                _token_count(usage.get("promptTokenCount")),
                _token_count(usage.get("candidatesTokenCount")),
            ),
        )


class LLMGateway:
    def __init__(self, providers):
        self.providers = tuple(providers)

    def complete(self, request):
        validate_request(request)
        if not self.providers:
            raise ProviderUnavailable("llm_not_configured")
        for provider in self.providers:
            try:
                reply = provider.complete(request)
                if isinstance(reply, LLMReply) and not reply.text.strip() and not reply.tool_calls:
                    reply = provider.complete(request)
                    if not reply.text.strip() and not reply.tool_calls:
                        raise ProviderUnavailable("llm_provider_empty_response", reply.provider)
                return reply
            except ProviderUnavailable:
                continue
        raise ProviderUnavailable("llm_provider_unavailable")


def _provider(name, config, client=None):
    if name == "openrouter" and config.openrouter_api_key.get_secret_value():
        return OpenAIProvider(
            name,
            "https://openrouter.ai/api/v1",
            config.llm_model,
            config.openrouter_api_key.get_secret_value(),
            config,
            client,
        )
    if name == "groq" and config.groq_api_key.get_secret_value():
        return OpenAIProvider(
            name,
            "https://api.groq.com/openai/v1",
            config.groq_model,
            config.groq_api_key.get_secret_value(),
            config,
            client,
        )
    if name == "local" and config.llm_local_base_url:
        return OllamaProvider(
            name, config.llm_local_base_url, config.llm_model or "local", config, client
        )
    if name == "gemini" and config.gemini_api_key.get_secret_value():
        return GeminiProvider(
            name,
            config.gemini_model,
            config.gemini_api_key.get_secret_value(),
            config,
            client,
        )
    return None


def gateway(config: Settings | None = None, client=None):
    config = config or settings()
    names = (config.llm_provider, *config.llm_fallback_provider_names)
    providers = [_provider(name, config, client) for name in names if name != "disabled"]
    return LLMGateway(provider for provider in providers if provider is not None)
