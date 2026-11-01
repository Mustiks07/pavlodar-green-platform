"""SYNTHETIC TEST approved scenario for WP-09 browser checks, in a disposable database only.

Work orders need the current revision of an approved scenario with placements; reaching approval
through the UI needs a complete durable calculation with accepted rates and models. As in the
backend execution tests, the zone and scenario go through the HTTP API of the isolated stack and
the approved revision with placements plus one complete snapshot (survival per placement, for the
forecast-vs-observed comparison) are written straight to the disposable database. Prints JSON.

    uv run python -m tools.dev.synthetic_execution_fixture
"""

import copy
import json
import os
from datetime import UTC, date, datetime
from pathlib import Path
from uuid import uuid4

import httpx
from sqlalchemy.engine import make_url

from services.api.config import settings

DISPOSABLE = {"pavlodar_claude_isolated", "pavlodar_browser_test"}
SPECIALIST_ID = "00000000-0000-4000-8000-000000000002"


def main():
    database = make_url(settings().database_url.get_secret_value()).database
    if database not in DISPOSABLE:
        raise SystemExit(f"Refusing to write fixtures into {database!r}: disposable databases only")
    sessions = json.loads(Path(os.environ["PG_SESSIONS"]).read_text(encoding="utf-8"))
    origin = os.environ["PG_WEB_URL"]

    from packages.domain.contracts import validate
    from services.api.db import session
    from services.api.models import (
        CalculationSnapshotRecord,
        PlantIdentity,
        Scenario,
        ScenarioRevision,
    )
    from tests.test_foundation import revision_body
    from tools.dev.seed import CITY_ID

    with httpx.Client(base_url=os.environ["PG_API_ORIGIN"], timeout=60) as client:
        client.cookies.set("pavlodar_session", sessions["specialist"]["cookie"])
        csrf = client.get("/v1/me").json()["csrf_token"]

        def mutate(path, body):
            headers = {"X-CSRF-Token": csrf, "Idempotency-Key": str(uuid4()), "Origin": origin}
            response = client.post(path, json=body, headers=headers)
            if response.status_code >= 400:
                raise SystemExit(f"POST {path}: {response.status_code} {response.text[:300]}")
            return response.json()

        ring = [[76.98, 52.28], [76.981, 52.28], [76.981, 52.281], [76.98, 52.281], [76.98, 52.28]]
        zone = mutate(
            "/v1/zones",
            {
                "city_id": CITY_ID,
                "name": "SYNTHETIC TEST исполнение",
                "purpose": "park",
                "geometry": {"type": "Polygon", "coordinates": [ring]},
            },
        )
        scenario = mutate(
            "/v1/scenarios",
            {
                "city_id": CITY_ID,
                "zone_id": zone["id"],
                "name": "SYNTHETIC TEST исполнение",
                "base_revision_id": None,
                "initial_state": revision_body(zone),
            },
        )

    today = date.today().isoformat()
    plants = [str(uuid4()) for _ in range(3)]
    placements = [
        {
            "id": str(uuid4()),
            "plant_id": plants[i],
            "stock_item_id": None,
            "position": {"type": "Point", "coordinates": [76.9803 + i * 0.0002, 52.2803]},
            "quantity": qty,
            "planting_date": today,
            "locked": False,
            "initial_height_m": None,
            "initial_crown_radius_m": None,
            "dimension_basis": "unknown",
        }
        for i, qty in enumerate([4, 2, 1])
    ]
    created = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    with session() as db, db.begin():
        stored = db.get(Scenario, scenario["id"])
        previous = db.get(ScenarioRevision, stored.current_revision_id)
        revision_id = str(uuid4())
        payload = copy.deepcopy(previous.payload)
        payload.update(
            {
                "id": revision_id,
                "parent_revision_id": previous.id,
                "placements": placements,
                "created_at": created,
                "input_hash": "0" * 64,
                "synthetic_inputs": True,
            }
        )
        for plant_id in plants:
            db.add(PlantIdentity(id=plant_id))
        db.add(
            ScenarioRevision(
                id=revision_id,
                scenario_id=stored.id,
                zone_version_id=previous.zone_version_id,
                parent_revision_id=previous.id,
                payload=payload,
            )
        )
        stored.current_revision_id = revision_id
        stored.status = "approved"
        stored.payload = {
            **stored.payload,
            "current_revision_id": revision_id,
            "status": "approved",
        }
        db.flush()
        snapshot_id = str(uuid4())
        snapshot = {
            "id": snapshot_id,
            "scenario_revision_id": revision_id,
            "input_hash": "b" * 64,
            "created_at": created,
            "status": "complete",
            "is_stale": False,
            "synthetic_inputs": True,
            "cost": {
                "currency": "KZT",
                "status": "complete",
                "known_subtotal": "0.00",
                "total": "0.00",
                "lines": [],
                "data_gaps": [],
            },
            "survival": [
                {
                    "placement_id": p["id"],
                    "model_kind": "expert_rules",
                    "calibration_status": "expert_confirmed",
                    "points": [
                        {"year": 1, "probability": 0.9, "lower": None, "upper": None},
                        {"year": 2, "probability": 0.85, "lower": None, "upper": None},
                        {"year": 3, "probability": 0.8, "lower": None, "upper": None},
                    ],
                    "risks": [],
                    "data_gaps": [],
                }
                for p in placements
            ],
            "care": [],
            "ecosystem": [],
            "warnings": [],
            "manifest_url": f"/v1/calculations/{snapshot_id}/manifest",
        }
        validate("CalculationSnapshot", snapshot)
        db.add(
            CalculationSnapshotRecord(
                id=snapshot_id,
                scenario_revision_id=revision_id,
                actor_id=SPECIALIST_ID,
                input_hash="b" * 64,
                created_at=datetime.fromisoformat(created),
                payload=snapshot,
                manifest={},
            )
        )
    print(
        json.dumps(
            {
                "zone_id": zone["id"],
                "scenario_id": scenario["id"],
                "revision_id": revision_id,
                "placements": placements,
                "snapshot_id": snapshot_id,
            }
        )
    )


if __name__ == "__main__":
    main()
