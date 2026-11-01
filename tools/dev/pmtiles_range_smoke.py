"""Disposable real-HTTP smoke for PMTiles registry, promotion and Range delivery."""

import hashlib
import json
import math
import time
from pathlib import Path
from uuid import uuid4

import httpx
from pmtiles.reader import MemorySource, Reader

from packages.domain.contracts import validate
from services.api.config import settings
from services.api.db import session
from services.worker.pmtiles import register_archive
from tools.dev.seed import CITY_ID
from tools.dev.smoke_oidc import login

ROOT = Path(__file__).parents[2]
BASE = "http://127.0.0.1:8001"
EVIDENCE = ROOT / "docs/evidence/wp03-pmtiles-range-live.json"


def key():
    return {"Idempotency-Key": str(uuid4())}


def tile_for(lon: float, lat: float, zoom: int):
    scale = 2**zoom
    x = int((lon + 180.0) / 360.0 * scale)
    latitude = math.radians(max(min(lat, 85.05112878), -85.05112878))
    y = int((1.0 - math.asinh(math.tan(latitude)) / math.pi) / 2.0 * scale)
    return x, y


def page(client, path, **params):
    response = client.get(path, params={**params, "limit": 200})
    assert response.status_code == 200, response.text
    return response.json()["items"]


def main():
    content = json.dumps(
        {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "id": "synthetic-pmtiles-live",
                    "properties": {"name": "SYNTHETIC TEST PMTiles Range"},
                    "geometry": {"type": "Point", "coordinates": [76.95, 52.28]},
                }
            ],
        },
        separators=(",", ":"),
    ).encode()
    with (
        httpx.Client(base_url=BASE, timeout=60, follow_redirects=False) as specialist,
        httpx.Client(base_url=BASE, timeout=60, follow_redirects=False) as admin,
        httpx.Client(base_url=BASE, timeout=60, follow_redirects=False) as viewer,
    ):
        login(specialist, "specialist")
        login(admin, "admin")
        login(viewer, "viewer")
        dataset = specialist.post(
            "/v1/datasets",
            headers=key(),
            json={
                "city_id": CITY_ID,
                "name": "SYNTHETIC TEST PMTiles Range",
                "kind": "green_inventory",
                "owner": "Disposable integration smoke",
                "license": "CC0-1.0",
                "access_level": "public",
                "source_uri": None,
            },
        )
        assert dataset.status_code == 201, dataset.text
        dataset_id = dataset.json()["id"]
        ticket = specialist.post(
            f"/v1/datasets/{dataset_id}/uploads",
            headers=key(),
            json={
                "filename": "synthetic-pmtiles-range.geojson",
                "content_type": "application/geo+json",
                "byte_size": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
            },
        )
        assert ticket.status_code == 201, ticket.text
        stored = specialist.put(
            ticket.json()["put_url"],
            headers={**key(), "Content-Type": "application/geo+json"},
            content=content,
        )
        assert stored.status_code == 204, stored.text
        queued = specialist.post(
            f"/v1/datasets/{dataset_id}/imports",
            headers=key(),
            json={
                "upload_id": ticket.json()["upload_id"],
                "format": "geojson",
                "source_crs": "EPSG:4326",
                "field_mapping": [{"source_field": "name", "target_field": "name"}],
                "observed_at": None,
                "method": "SYNTHETIC TEST disposable PMTiles smoke",
                "spatial_resolution_m": None,
            },
        )
        assert queued.status_code == 202, queued.text
        job = queued.json()
        deadline = time.monotonic() + 60
        while job["state"] not in {"succeeded", "failed", "cancelled"}:
            assert time.monotonic() < deadline, "Import job did not finish"
            time.sleep(0.5)
            response = specialist.get(f"/v1/jobs/{job['id']}")
            assert response.status_code == 200, response.text
            job = response.json()
        assert job["state"] == "succeeded", job
        published = admin.post(
            f"/v1/dataset-versions/{job['result_ref_id']}/publish",
            headers=key(),
            json={"reason": "SYNTHETIC TEST disposable PMTiles Range acceptance"},
        )
        assert published.status_code == 200, published.text

        layer = next(
            item
            for item in page(specialist, "/v1/map/layers", city_id=CITY_ID)
            if item["dataset_id"] == dataset_id
        )
        assert layer["source_type"] == "mvt"
        x, y = tile_for(76.95, 52.28, 12)
        dynamic_url = (
            layer["source_url"]
            .replace("{z}", "12")
            .replace("{x}", str(x))
            .replace("{y}", str(y))
        )
        dynamic = specialist.get(dynamic_url)
        assert dynamic.status_code == 200 and dynamic.content

        with session() as db, db.begin():
            built = register_archive(
                db,
                layer["id"],
                Path(settings().tile_root),
                min_zoom=10,
                max_zoom=12,
            )
        promoted = next(
            item
            for item in page(viewer, "/v1/map/layers", city_id=CITY_ID)
            if item["id"] == layer["id"]
        )
        validate("MapLayer", promoted)
        assert promoted["source_type"] == "pmtiles"
        archive = viewer.get(promoted["source_url"])
        assert archive.status_code == 200
        assert hashlib.sha256(archive.content).hexdigest() == built.sha256
        assert Reader(MemorySource(archive.content)).get(12, x, y) == dynamic.content

        partial = viewer.get(promoted["source_url"], headers={"Range": "bytes=0-126"})
        assert partial.status_code == 206 and partial.content == archive.content[:127]
        assert partial.headers["content-range"] == f"bytes 0-126/{len(archive.content)}"
        etag = partial.headers["etag"]
        assert viewer.get(
            promoted["source_url"], headers={"If-None-Match": etag}
        ).status_code == 304
        invalid = viewer.get(
            promoted["source_url"], headers={"Range": f"bytes={len(archive.content)}-"}
        )
        assert invalid.status_code == 416
        assert invalid.json()["code"] == "range_not_satisfiable"
        with httpx.Client(base_url=BASE, timeout=30) as anonymous:
            assert anonymous.get(promoted["source_url"]).status_code == 401

    evidence = {
        "passed": True,
        "scope": "Disposable real OIDC -> import -> publication -> immutable PMTiles registry -> HTTP full/Range/ETag delivery",
        "synthetic_test_input": True,
        "shared_database_mutated": False,
        "dataset_id": dataset_id,
        "layer_id": layer["id"],
        "archive_sha256": built.sha256,
        "byte_size": built.byte_size,
        "tile_count": built.tile_count,
        "candidate_tile_count": built.candidate_tile_count,
        "range_status": partial.status_code,
        "anonymous_status": 401,
        "contract_version": "1.5.0",
    }
    EVIDENCE.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()
