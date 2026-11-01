"""One real assistant round-trip against the running local platform."""

import argparse
import json
import sys

from tools.dev.demo_bootstrap import sign_in, wait_job


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://localhost:8001")
    parser.add_argument("--city-id", required=True)
    parser.add_argument(
        "--question",
        default="Кратко объясни этот вариант озеленения и назови следующий полезный шаг.",
    )
    args = parser.parse_args()
    clients = sign_in(args.base_url)
    specialist = clients["specialist"]
    try:
        scenarios = specialist.pages("/v1/scenarios", city_id=args.city_id)
        if not scenarios:
            raise SystemExit("No scenario is available for the assistant smoke")
        scenario = next(
            (item for item in scenarios if item["name"].startswith("Вариант")), scenarios[0]
        )
        session = specialist.send(
            "POST",
            "/v1/chat/sessions",
            {
                "city_id": args.city_id,
                "zone_id": scenario["zone_id"],
                "scenario_revision_id": scenario["current_revision_id"],
            },
        )
        job = specialist.send(
            "POST",
            f"/v1/chat/sessions/{session['id']}/messages",
            {"text": args.question, "scenario_revision_id": None},
            expect=(202,),
        )
        wait_job(specialist, job["id"])
        messages = specialist.pages(f"/v1/chat/sessions/{session['id']}/messages")
        answer = next(
            (
                message
                for message in reversed(messages)
                if message["role"] == "assistant" and message["state"] == "completed"
            ),
            None,
        )
        if not answer or not answer["text"].strip():
            raise SystemExit("Assistant completed without an answer")
        print(
            json.dumps(
                {
                    "scenario": scenario["name"],
                    "provider": answer.get("provider"),
                    "model": answer.get("model"),
                    "answer": answer["text"],
                    "facts": len(answer.get("facts") or []),
                },
                ensure_ascii=False,
            )
        )
    finally:
        for client in clients.values():
            client.http.close()


if __name__ == "__main__":
    main()
