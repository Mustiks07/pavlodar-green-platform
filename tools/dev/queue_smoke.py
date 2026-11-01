"""Local broker outage/recovery check. Expected job failure is honest: no domain handler yet."""

import json
import subprocess
import time
from pathlib import Path

import httpx
from sqlalchemy import select

from services.api.config import settings
from services.api.db import session
from services.api.models import Job, Principal, ScenarioRevision
from services.api.security import Access
from services.worker.jobs import enqueue

ROOT = Path(__file__).resolve().parents[2]


def main():
    if settings().environment not in {"test", "development"}:
        raise SystemExit("Local test environment required")
    container = "pavlodar-gpt-redis-1"
    subprocess.run(["docker", "stop", container], check=True, capture_output=True)
    try:
        with session() as db, db.begin():
            user = db.get(Principal, "00000000-0000-4000-8000-000000000002")
            revision = db.scalar(select(ScenarioRevision).order_by(ScenarioRevision.id).limit(1))
            assert revision and revision.payload["synthetic_inputs"]
            job_id = enqueue(db, Access(db, user, None), revision, "calculate").id
        with session() as db:
            assert db.get(Job, job_id).state == "queued"
        assert httpx.get("http://127.0.0.1:8001/health/ready", timeout=10).status_code == 200
    finally:
        subprocess.run(["docker", "start", container], check=True, capture_output=True)
    deadline = time.monotonic() + 50
    while time.monotonic() < deadline:
        with session() as db:
            job = db.get(Job, job_id)
            if job.state == "failed":
                assert job.payload["error"]["code"] == "handler_not_available"
                result = {
                    "passed": True,
                    "job_id": job_id,
                    "broker_outage_preserved_job": True,
                    "api_readiness_during_broker_outage": 200,
                    "redis_restarted": True,
                    "celery_received_job": True,
                    "terminal_state": "failed",
                    "terminal_code": "handler_not_available",
                    "scope": "Real Redis/Celery/PostgreSQL delivery recovery; not a completed domain calculation",
                }
                (ROOT / "docs/evidence/foundation_queue.json").write_text(
                    json.dumps(result, indent=2) + "\n"
                )
                print(json.dumps(result, indent=2))
                return
        time.sleep(2)
    raise RuntimeError("Worker did not receive persisted job after broker recovery")


if __name__ == "__main__":
    main()
