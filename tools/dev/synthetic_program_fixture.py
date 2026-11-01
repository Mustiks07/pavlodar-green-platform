"""SYNTHETIC TEST program revision for browser checks, in a disposable database only.

A ProgramRevision only exists after optimizeProgram, which needs a frozen priority result and
complete calculations for the candidate revisions. Zones, scenarios, the program and the
optimization go through the HTTP API of the isolated stack (cookie session from PG_SESSIONS);
the priority result and calculation snapshots reuse the backend test helper, written straight to
the disposable database. Prints {"program_id", "program_revision_id", "scenario_revision_ids"}.

    uv run python -m tools.dev.synthetic_program_fixture
"""

import json
import os
import time
from pathlib import Path
from uuid import uuid4

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
    with httpx.Client(base_url=os.environ["PG_API_ORIGIN"], timeout=60) as client:
        client.cookies.set("pavlodar_session", sessions["specialist"]["cookie"])
        csrf = client.get("/v1/me").json()["csrf_token"]

        def mutate(method, path, body, etag=None):
            headers = {"X-CSRF-Token": csrf, "Idempotency-Key": str(uuid4()), "Origin": origin}
            if etag:
                headers["If-Match"] = etag
            response = client.request(method, path, json=body, headers=headers)
            if response.status_code >= 400:
                raise SystemExit(f"{method} {path}: {response.status_code} {response.text[:300]}")
            return response

        from tests.test_foundation import revision_body
        from tests.test_program_optimization_api import add_priority_and_calculations
        from tools.dev.seed import CITY_ID

        zones, revisions = [], []
        for n, west in enumerate([76.980, 76.983]):
            ring = [
                [west, 52.28],
                [west + 0.001, 52.28],
                [west + 0.001, 52.281],
                [west, 52.281],
                [west, 52.28],
            ]
            zone = mutate(
                "POST",
                "/v1/zones",
                {
                    "city_id": CITY_ID,
                    "name": f"SYNTHETIC TEST программа {n}",
                    "purpose": "park",
                    "geometry": {"type": "Polygon", "coordinates": [ring]},
                },
            ).json()
            scenario = mutate(
                "POST",
                "/v1/scenarios",
                {
                    "city_id": CITY_ID,
                    "zone_id": zone["id"],
                    "name": f"SYNTHETIC TEST программа {n}",
                    "base_revision_id": None,
                    "initial_state": revision_body(zone),
                },
            ).json()
            zones.append(zone["id"])
            revisions.append(scenario["current_revision_id"])
        body = {
            "city_id": CITY_ID,
            "name": "SYNTHETIC TEST программа озеленения",
            "capital_budget": "100.00",
            "resource_limits": [
                {
                    "period": "year:1",
                    "water_m3": 100.0,
                    "crew_minutes": 1000,
                    "max_visits": 10,
                    "care_budget": "20000.00",
                }
            ],
            "candidate_revision_ids": revisions,
            "required_zone_ids": [],
            "excluded_zone_ids": [],
            "benefit_weights": [{"factor": "green_deficit", "weight": 1.0}],
            "diversity_caps": [],
            "coverage_requirements": [],
        }
        body["priority_result_id"] = add_priority_and_calculations(body)
        created = mutate("POST", "/v1/programs", body)
        program = created.json()
        queued = mutate(
            "POST",
            f"/v1/programs/{program['id']}/optimize",
            {"program_id": program["id"], "time_limit_seconds": 5, "seed": 11},
            etag=created.headers["etag"],
        ).json()
        for _ in range(240):
            job = client.get(f"/v1/jobs/{queued['id']}").json()
            if job["state"] in {"succeeded", "failed", "cancelled"}:
                break
            time.sleep(0.5)
        if job["state"] != "succeeded":
            raise SystemExit(f"Optimization job ended {job['state']}: {job.get('error')}")
        print(
            json.dumps(
                {
                    "program_id": program["id"],
                    "program_revision_id": job["result_ref_id"],
                    "scenario_revision_ids": revisions,
                }
            )
        )


if __name__ == "__main__":
    main()
