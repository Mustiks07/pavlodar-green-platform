import json

import pytest
from sqlalchemy import text

from packages.domain.heights import record_height
from services.api.db import session
from services.api.tiles import TILE_HEIGHT_COLUMNS, TILE_HEIGHT_LATERAL
from services.worker.main import run_job
from tests.test_foundation import mutation
from tests.test_imports import create_dataset, start_import, tile_for, upload

pytestmark = pytest.mark.integration

CASES = [
    {},
    {"height": 12},
    {"height": 12.5},
    {"height": "15"},
    {"height": " 7,5 м "},
    {"height": "9 metres"},
    {"height": "9M"},
    {"height": "tall"},
    {"height": "-3"},
    {"height": 0},
    {"height": -4},
    {"height": True},
    {"height": None},
    {"height_m": 30, "height_basis": "measured"},
    {"height_m": 30, "height_basis": "visual_placeholder", "height": 5},
    {"height_m": 30, "height_basis": "unknown", "height": 5},
    {"height_m": 30, "height_basis": "invented", "height": 5},
    {"height_m": "30", "height_basis": "measured"},
    {"height_m": 0, "height_basis": "measured", "height": 8},
    {"height_m": 22.4, "height_basis": "floors_estimate", "floors": 7},
    {"building:levels": 9},
]


@pytest.mark.parametrize("properties", CASES, ids=[json.dumps(c, ensure_ascii=False) for c in CASES])
def test_tile_height_sql_matches_record_height(database, properties):
    statement = text(
        f"SELECT {TILE_HEIGHT_COLUMNS} "
        "FROM (SELECT CAST(:properties AS jsonb) AS properties) generalized_rows"
        f"{TILE_HEIGHT_LATERAL}"
    )
    with session() as db:
        row = db.execute(statement, {"properties": json.dumps(properties)}).one()
    height, basis, _ = record_height(properties)
    assert (row.height_m, row.height_basis) == (height, basis)
    assert "height_m" not in row.properties and "height_basis" not in row.properties


def test_published_building_tile_carries_server_height(clients):
    specialist = clients["specialist"]
    dataset = create_dataset(specialist, access_level="public", kind="buildings")
    ring = [[76.95, 52.28], [76.9502, 52.28], [76.9502, 52.2802], [76.95, 52.2802], [76.95, 52.28]]
    content = json.dumps(
        {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "id": "synthetic-building",
                    "properties": {"name": "SYNTHETIC TEST building", "height": "18 m"},
                    "geometry": {"type": "Polygon", "coordinates": [ring]},
                }
            ],
        }
    ).encode()
    ticket = upload(specialist, dataset["id"], content, "application/geo+json", "building.geojson")
    job = start_import(specialist, dataset["id"], ticket, "geojson")
    run_job.run(job["id"])
    version_id = specialist.get(f"/v1/jobs/{job['id']}").json()["result_ref_id"]
    published = mutation(
        clients["admin"],
        "POST",
        f"/v1/dataset-versions/{version_id}/publish",
        {"reason": "SYNTHETIC TEST building heights in tiles"},
    )
    assert published.status_code == 200, published.text
    layers = specialist.get(f"/v1/map/layers?city_id={dataset['city_id']}&limit=200").json()
    layer = next(item for item in layers["items"] if item["dataset_id"] == dataset["id"])
    x, y = tile_for(76.9501, 52.2801, 15)
    url = layer["source_url"].replace("{z}", "15").replace("{x}", str(x)).replace("{y}", str(y))
    tile = specialist.get(url)
    assert tile.status_code == 200, tile.text
    # MVT keeps attribute keys and string values as plain bytes.
    assert b"height_m" in tile.content and b"recorded_unverified" in tile.content
