"""SYNTHETIC TEST draft scenario for assistant browser checks, in a disposable database only.

A proposal is only offered for the current revision of a draft scenario with an unlocked
placement, and applying it goes through the ordinary save_revision checks (catalog, rule, zone
geometry). So the catalog, rule, rate, zone, scenario and calculable revision are created through
the HTTP API of the isolated stack with the backend test helpers; their import jobs are run by the
stack's own worker (the helper's in-process run is replaced by waiting for the job). Prints JSON.

    uv run python -m tools.dev.synthetic_chat_fixture
"""

import json
import os
import time
from pathlib import Path

import httpx
from sqlalchemy.engine import make_url

from services.api.config import settings

DISPOSABLE = {"pavlodar_claude_isolated", "pavlodar_browser_test"}


def main():
    database = make_url(settings().database_url.get_secret_value()).database
    if database not in DISPOSABLE:
        raise SystemExit(f"Refusing to write fixtures into {database!r}: disposable databases only")
    sessions = json.loads(Path(os.environ["PG_SESSIONS"]).read_text(encoding="utf-8"))
    origin = os.environ["PG_WEB_URL"]
    clients = {}
    for role in ("admin", "specialist", "viewer"):
        client = httpx.Client(base_url=os.environ["PG_API_ORIGIN"], timeout=180)
        client.cookies.set("pavlodar_session", sessions[role]["cookie"])
        csrf = client.get("/v1/me").json()["csrf_token"]
        client.headers.update({"Origin": origin, "X-CSRF-Token": csrf})
        clients[role] = client

    from services.worker.main import run_job

    def wait_for_worker(job_id):
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            for client in clients.values():
                job = client.get(f"/v1/jobs/{job_id}")
                if job.status_code == 200 and job.json()["state"] in {"succeeded", "failed", "cancelled"}:
                    return
            time.sleep(0.5)
        raise SystemExit(f"Job {job_id} did not finish on the isolated worker")

    run_job.run = wait_for_worker

    from tests.test_calculations import setup_revision

    scenario, revision, saved, _ = setup_revision(clients)
    print(
        json.dumps(
            {
                "scenario_id": scenario["id"],
                "zone_id": scenario["zone_id"],
                "revision_id": saved.json()["id"],
                "placement_id": revision["placements"][0]["id"],
                "quantity": revision["placements"][0]["quantity"],
            }
        )
    )
    for client in clients.values():
        client.close()


if __name__ == "__main__":
    main()
