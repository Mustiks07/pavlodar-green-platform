"""Explicit test-only seed. Does not satisfy any organizer or calibration data gate."""

import argparse
import json
from pathlib import Path

from services.api.config import settings
from services.api.db import session
from services.api.models import CatalogState, City, CityGrant, Principal

CITY_ID = "10000000-0000-4000-8000-000000000001"
CITY_NAME = "Павлодар — рабочий контур OSM"
BOUNDARY_VERSION_ID = "6db8cbb3-51b8-5363-b941-15186deafdf4"
BOUNDARY_FILE = Path(__file__).resolve().parents[2] / "research" / "data" / "DR-01" / "working_boundary.geojson"


def city_payload() -> dict:
    document = json.loads(BOUNDARY_FILE.read_text(encoding="utf-8"))
    boundary = document["features"][0]["geometry"]
    return {
        "id": CITY_ID,
        "name": CITY_NAME,
        "timezone": "Asia/Almaty",
        "metric_crs": "EPSG:32643",
        "boundary": boundary,
        "boundary_status": "working",
        "boundary_version_id": BOUNDARY_VERSION_ID,
    }


def seed():
    config = settings()
    if config.environment not in {"test", "development"} or not config.oidc_issuer.endswith(
        "/pavlodar-test"
    ):
        raise SystemExit("Seed only allowed with explicit test realm in development/test")
    with session() as db, db.begin():
        if not db.get(CatalogState, "global"):
            db.add(CatalogState(key="global", current_version_id=None))
        city = db.get(City, CITY_ID)
        payload = city_payload()
        if not city:
            db.add(
                City(
                    id=CITY_ID,
                    synthetic=True,
                    payload=payload,
                )
            )
            db.flush()
        else:
            # Keep the canonical city id so every imported dataset, zone and scenario remains
            # linked, while replacing the obsolete rectangular seed with the checked-in DR-01
            # working boundary. This is deliberately idempotent for existing demo databases.
            city.payload = {**city.payload, **payload}
        for index, role in enumerate(["admin", "specialist", "viewer"], start=1):
            user_id = f"00000000-0000-4000-8000-{index:012}"
            if not db.get(Principal, user_id):
                db.add(
                    Principal(
                        id=user_id,
                        issuer=config.oidc_issuer,
                        subject=user_id,
                        display_name="SYNTHETIC TEST " + role,
                        roles=[role],
                        active=True,
                    )
                )
                db.flush()
                db.add(CityGrant(user_id=user_id, city_id=CITY_ID))
    print("Synthetic test city and identity grants seeded idempotently. No prices/models invented.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", choices=["test"], required=True)
    parser.parse_args()
    seed()
