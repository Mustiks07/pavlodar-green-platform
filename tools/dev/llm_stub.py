"""Deterministic OpenAI-compatible LLM stub for the isolated browser stack (loopback only).

Nothing leaves the machine. The reply depends only on the request, so browser checks can drive
every assistant state through the real API -> outbox -> worker -> provider path:

- text containing "SYNTHETIC FAIL" -> HTTP 503 (provider unavailable, the job fails);
- text containing "SYNTHETIC SLOW" -> answers after a delay, so the job can be cancelled first;
- text containing "SYNTHETIC PROPOSE" with the proposal tool offered -> one
  propose_placement_quantity call for the first unlocked placement (quantity + 1);
- anything else -> a plain SYNTHETIC TEST answer without numbers.

    uv run python -m tools.dev.llm_stub --port 8019
"""

import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SLOW_SECONDS = 8


def _context(messages):
    for message in messages:
        content = message.get("content") or ""
        if message.get("role") == "system" and content.startswith("AUTHORIZED_CONTEXT="):
            return json.loads(content.removeprefix("AUTHORIZED_CONTEXT="))
    return {}


def reply(payload):
    messages = payload.get("messages") or []
    text = next((m.get("content") or "" for m in reversed(messages) if m.get("role") == "user"), "")
    tools = {item["function"]["name"] for item in payload.get("tools") or []}
    if "SYNTHETIC FAIL" in text:
        return 503, {"error": {"message": "SYNTHETIC TEST provider outage"}}
    if "SYNTHETIC SLOW" in text:
        time.sleep(SLOW_SECONDS)
    message = {"role": "assistant", "content": "SYNTHETIC TEST: ответ без расчётных чисел."}
    placements = (_context(messages).get("scenario") or {}).get("placements") or []
    target = next((item for item in placements if item.get("locked") is False), None)
    if "SYNTHETIC PROPOSE" in text and "propose_placement_quantity" in tools and target:
        arguments = {
            "summary": "SYNTHETIC TEST: увеличить количество в одном размещении на 1",
            "placement_id": target["id"],
            "quantity": target["quantity"] + 1,
        }
        message = {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call-1",
                    "type": "function",
                    "function": {
                        "name": "propose_placement_quantity",
                        "arguments": json.dumps(arguments, ensure_ascii=False),
                    },
                }
            ],
        }
    return 200, {
        "choices": [{"index": 0, "message": message, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1},
    }


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if not self.path.endswith("/chat/completions"):
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        status, body = reply(json.loads(self.rfile.read(length) or b"{}"))
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8019)
    port = parser.parse_args().port
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
