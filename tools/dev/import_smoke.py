"""Real OIDC + HTTP + Redis/Celery generic GeoJSON import and admin publication smoke."""

import hashlib
import json
import time
from pathlib import Path
from uuid import UUID, uuid4

import httpx

from packages.domain.contracts import validate
from services.api.research import CITY_ID
from tools.dev.smoke_oidc import login

ROOT = Path(__file__).parents[2]
BASE = "http://localhost:8001"


def key():
    return {"Idempotency-Key": str(uuid4())}


def main():
    content = json.dumps(
        {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "id": "synthetic-live-1",
                    "properties": {"name": "SYNTHETIC LIVE IMPORT"},
                    "geometry": {"type": "Point", "coordinates": [76.95, 52.28]},
                }
            ],
        },
        separators=(",", ":"),
    ).encode()
    with httpx.Client(base_url=BASE, timeout=30, follow_redirects=False) as specialist:
        login(specialist, "specialist")
        dataset = specialist.post(
            "/v1/datasets",
            headers=key(),
            json={
                "city_id": CITY_ID,
                "name": "SYNTHETIC LIVE generic GeoJSON import",
                "kind": "green_inventory",
                "owner": "Integration smoke",
                "license": "CC0-1.0",
                "access_level": "internal",
                "source_uri": None,
            },
        )
        assert dataset.status_code == 201, dataset.text
        ticket = specialist.post(
            f"/v1/datasets/{dataset.json()['id']}/uploads",
            headers=key(),
            json={
                "filename": "synthetic-live.geojson",
                "content_type": "application/geo+json",
                "byte_size": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
            },
        )
        assert ticket.status_code == 201, ticket.text
        validate("UploadTicket", ticket.json())
        stored = specialist.put(
            ticket.json()["put_url"],
            headers={**key(), "Content-Type": "application/geo+json"},
            content=content,
        )
        assert stored.status_code == 204, stored.text
        queued = specialist.post(
            f"/v1/datasets/{dataset.json()['id']}/imports",
            headers=key(),
            json={
                "upload_id": ticket.json()["upload_id"],
                "format": "geojson",
                "source_crs": "EPSG:4326",
                "field_mapping": [{"source_field": "name", "target_field": "name"}],
                "observed_at": None,
                "method": "SYNTHETIC LIVE integration smoke",
                "spatial_resolution_m": None,
            },
        )
        assert queued.status_code == 202, queued.text
        validate("Job", queued.json())
        deadline = time.monotonic() + 45
        job = queued.json()
        while job["state"] not in {"succeeded", "failed", "cancelled"}:
            assert time.monotonic() < deadline, "Import job did not finish"
            time.sleep(1)
            response = specialist.get(f"/v1/jobs/{job['id']}")
            assert response.status_code == 200, response.text
            job = response.json()
        assert job["state"] == "succeeded", job
        quality = specialist.get(f"/v1/dataset-versions/{job['result_ref_id']}/quality")
        assert quality.status_code == 200, quality.text
        validate("QualityReport", quality.json())
        assert quality.json()["publish_allowed"] and quality.json()["valid_count"] == 1

    with httpx.Client(base_url=BASE, timeout=30, follow_redirects=False) as admin:
        login(admin, "admin")
        published = admin.post(
            f"/v1/dataset-versions/{job['result_ref_id']}/publish",
            headers=key(),
            json={"reason": "SYNTHETIC LIVE import smoke reviewed"},
        )
        assert published.status_code == 200, published.text
        validate("DatasetVersion", published.json())
        assert published.json()["status"] == "published"
        layers = admin.get("/v1/map/layers", params={"city_id": CITY_ID, "limit": 200})
        assert layers.status_code == 200, layers.text
        own_layers = [
            layer
            for layer in layers.json()["items"]
            if layer["dataset_version_id"] == job["result_ref_id"]
        ]
        assert len(own_layers) == 1, own_layers
        validate("MapLayer", own_layers[0])
        tile_url = (
            own_layers[0]["source_url"]
            .replace("{z}", "0")
            .replace("{x}", "0")
            .replace("{y}", "0")
        )
        tile = admin.get(tile_url)
        assert tile.status_code == 200 and tile.content, tile.text
        unchanged = admin.get(tile_url, headers={"If-None-Match": tile.headers["etag"]})
        assert unchanged.status_code == 304
        feature_id = str(
            UUID(
                hashlib.md5(
                    f"pavlodar:map-feature:{job['result_ref_id']}:0".encode(),
                    usedforsecurity=False,
                ).hexdigest()
            )
        )
        assert feature_id.encode() in tile.content
        feature = admin.get(f"/v1/map/features/{feature_id}")
        assert feature.status_code == 200, feature.text
        validate("MapFeature", feature.json())
        assert feature.json()["source_refs"][0]["source_record_id"] == "synthetic-live-1"

    result = {
        "passed": True,
        "scope": "Real OIDC, HTTP upload, PostgreSQL outbox, Redis/Celery import, atomic admin publication, MapLayer manifest, authorized PostGIS MVT and canonical feature detail",
        "dataset_id": dataset.json()["id"],
        "upload_id": ticket.json()["upload_id"],
        "job_id": job["id"],
        "dataset_version_id": job["result_ref_id"],
        "valid_count": quality.json()["valid_count"],
        "map_layer_id": own_layers[0]["id"],
        "map_feature_id": feature_id,
        "mvt_bytes": len(tile.content),
        "organizer_data_received": False,
        "synthetic_test_input": True,
        "supported_in_this_increment": ["geojson", "csv"],
        "still_rejected_with_quality_report": ["kml", "shp_zip"],
    }
    (ROOT / "docs/evidence/import_api.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
