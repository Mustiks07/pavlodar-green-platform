"""Real OIDC/Celery KML and Shapefile publication smoke with synthetic fixtures."""

import hashlib
import io
import json
import time
import zipfile
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import shapefile

from packages.domain.contracts import validate
from services.api.research import CITY_ID
from tools.dev.smoke_oidc import login

ROOT = Path(__file__).parents[2]
BASE = "http://localhost:8001"


def key():
    return {"Idempotency-Key": str(uuid4())}


def kml_bytes():
    return (
        b'<?xml version="1.0" encoding="UTF-8"?>'
        b'<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
        b'<Placemark id="synthetic-live-kml-1"><name>SYNTHETIC LIVE KML tree</name>'
        b'<ExtendedData><Data name="kind"><value>tree</value></Data></ExtendedData>'
        b'<Point><coordinates>76.95,52.28,0</coordinates></Point></Placemark>'
        b"</Document></kml>"
    )


def shp_zip_bytes():
    shp, shx, dbf = io.BytesIO(), io.BytesIO(), io.BytesIO()
    writer = shapefile.Writer(shp=shp, shx=shx, dbf=dbf, encoding="utf-8")
    writer.field("name", "C", size=80)
    writer.point(76.96, 52.29)
    writer.record("SYNTHETIC LIVE SHP tree")
    writer.close()
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("synthetic.shp", shp.getvalue())
        archive.writestr("synthetic.shx", shx.getvalue())
        archive.writestr("synthetic.dbf", dbf.getvalue())
        archive.writestr("synthetic.cpg", "UTF-8")
    return stream.getvalue()


def import_one(client, fixture):
    dataset = client.post(
        "/v1/datasets",
        headers=key(),
        json={
            "city_id": CITY_ID,
            "name": f"SYNTHETIC LIVE {fixture['format']} import",
            "kind": "green_inventory",
            "owner": "Integration smoke",
            "license": "CC0-1.0",
            "access_level": "internal",
            "source_uri": None,
        },
    )
    assert dataset.status_code == 201, dataset.text
    content = fixture["content"]
    ticket = client.post(
        f"/v1/datasets/{dataset.json()['id']}/uploads",
        headers=key(),
        json={
            "filename": fixture["filename"],
            "content_type": fixture["content_type"],
            "byte_size": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
        },
    )
    assert ticket.status_code == 201, ticket.text
    stored = client.put(
        ticket.json()["put_url"],
        headers={**key(), "Content-Type": fixture["content_type"]},
        content=content,
    )
    assert stored.status_code == 204, stored.text
    queued = client.post(
        f"/v1/datasets/{dataset.json()['id']}/imports",
        headers=key(),
        json={
            "upload_id": ticket.json()["upload_id"],
            "format": fixture["format"],
            "source_crs": "EPSG:4326",
            "field_mapping": [{"source_field": "name", "target_field": "name"}],
            "observed_at": None,
            "method": "SYNTHETIC LIVE isolated parser smoke",
            "spatial_resolution_m": None,
        },
    )
    assert queued.status_code == 202, queued.text
    deadline, job = time.monotonic() + 60, queued.json()
    while job["state"] not in {"succeeded", "failed", "cancelled"}:
        assert time.monotonic() < deadline, f"{fixture['format']} import did not finish"
        time.sleep(1)
        response = client.get(f"/v1/jobs/{job['id']}")
        assert response.status_code == 200, response.text
        job = response.json()
    assert job["state"] == "succeeded", job
    quality = client.get(f"/v1/dataset-versions/{job['result_ref_id']}/quality")
    assert quality.status_code == 200, quality.text
    validate("QualityReport", quality.json())
    assert quality.json()["publish_allowed"] and quality.json()["valid_count"] == 1
    return {
        "format": fixture["format"],
        "dataset_id": dataset.json()["id"],
        "upload_id": ticket.json()["upload_id"],
        "job_id": job["id"],
        "dataset_version_id": job["result_ref_id"],
        "source_record_id": fixture["source_record_id"],
    }


def publish_one(client, run):
    published = client.post(
        f"/v1/dataset-versions/{run['dataset_version_id']}/publish",
        headers=key(),
        json={"reason": f"SYNTHETIC LIVE {run['format']} smoke reviewed"},
    )
    assert published.status_code == 200, published.text
    validate("DatasetVersion", published.json())
    layers = client.get("/v1/map/layers", params={"city_id": CITY_ID, "limit": 200})
    assert layers.status_code == 200, layers.text
    own = [
        item
        for item in layers.json()["items"]
        if item["dataset_version_id"] == run["dataset_version_id"]
    ]
    assert len(own) == 1, own
    validate("MapLayer", own[0])
    tile_url = own[0]["source_url"].replace("{z}", "0").replace("{x}", "0").replace("{y}", "0")
    tile = client.get(tile_url)
    assert tile.status_code == 200 and tile.content, tile.text
    feature_id = str(
        UUID(
            hashlib.md5(
                f"pavlodar:map-feature:{run['dataset_version_id']}:0".encode(),
                usedforsecurity=False,
            ).hexdigest()
        )
    )
    feature = client.get(f"/v1/map/features/{feature_id}")
    assert feature.status_code == 200, feature.text
    validate("MapFeature", feature.json())
    assert feature.json()["source_refs"][0]["source_record_id"] == run["source_record_id"]
    return {**run, "map_layer_id": own[0]["id"], "map_feature_id": feature_id, "mvt_bytes": len(tile.content)}


def main():
    fixtures = [
        {
            "format": "kml",
            "filename": "synthetic-live.kml",
            "content_type": "application/vnd.google-earth.kml+xml",
            "content": kml_bytes(),
            "source_record_id": "synthetic-live-kml-1",
        },
        {
            "format": "shp_zip",
            "filename": "synthetic-live.zip",
            "content_type": "application/zip",
            "content": shp_zip_bytes(),
            "source_record_id": "0",
        },
    ]
    with httpx.Client(base_url=BASE, timeout=30, follow_redirects=False) as specialist:
        login(specialist, "specialist")
        runs = [import_one(specialist, fixture) for fixture in fixtures]
    with httpx.Client(base_url=BASE, timeout=30, follow_redirects=False) as admin:
        login(admin, "admin")
        runs = [publish_one(admin, run) for run in runs]
    result = {
        "passed": True,
        "scope": "Real OIDC, HTTP, outbox, Redis/Celery, isolated bounded parsers, publication, MVT and feature lineage",
        "runs": runs,
        "organizer_data_received": False,
        "synthetic_test_inputs": True,
        "limitations": [
            "WGS84 only",
            "one shapefile dataset per archive",
            "upload-volume disaster recovery remains pending",
        ],
    }
    (ROOT / "docs/evidence/wp03-kml-shp-live.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
