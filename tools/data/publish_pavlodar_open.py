"""Publish admitted Pavlodar open GeoJSON through the real HTTP import/review pipeline."""

import argparse
import hashlib
import json
import time
from pathlib import Path
from uuid import uuid4

import httpx

from packages.domain.contracts import validate
from services.api.research import CITY_ID
from tools.dev.smoke_oidc import login

ROOT = Path(__file__).parents[2]
EVIDENCE = ROOT / "docs/evidence/pavlodar_open_import.json"
DATASET_NAMES = {
    "roads": "Дороги Павлодара",
    "green": "Зелёные территории Павлодара",
    "trees": "Деревья Павлодара",
    "water": "Водные объекты Павлодара",
    "buildings": "Здания Павлодара с высотой",
}


def key():
    return {"Idempotency-Key": str(uuid4())}


def pages(client, path, params=None):
    params = {**(params or {}), "limit": 200}
    items = []
    while True:
        response = client.get(path, params=params)
        assert response.status_code == 200, response.text
        page = response.json()
        items.extend(page["items"])
        if not page["next_cursor"]:
            return items
        params["cursor"] = page["next_cursor"]


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def layer_specs(manifest_path):
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    specs = []
    for layer in manifest["layers"]:
        path = Path(layer["path"])
        if not path.is_absolute():
            path = ROOT / path
        specs.append(
            {
                "profile": layer["profile"],
                "name": DATASET_NAMES[layer["profile"]],
                "kind": layer["kind"],
                "path": path,
                "sha256": layer["sha256"],
                "observed_at": layer["observed_at"],
                "method": (
                    "Bounded Overpass out tags geom for the Pavlodar working bbox; "
                    "ways/nodes only; invalid geometry excluded"
                ),
                "feature_count": layer["feature_count"],
            }
        )
    buildings = ROOT / "research/data/DR-06/buildings.geojson"
    specs.append(
        {
            "profile": "buildings",
            "name": DATASET_NAMES["buildings"],
            "kind": "buildings",
            "path": buildings,
            "sha256": sha256(buildings),
            "observed_at": "2026-10-28T21:21:02Z",
            "method": (
                "Pinned OSM PBF preflight; numeric height tags only; "
                "no building:levels estimate and no placeholder height"
            ),
            "feature_count": 110,
        }
    )
    return specs


def dataset_for(client, datasets, spec):
    matches = [item for item in datasets if item["name"] == spec["name"]]
    if len(matches) > 1:
        raise RuntimeError(f"Multiple canonical datasets named {spec['name']}")
    if matches:
        dataset = matches[0]
        if dataset["kind"] != spec["kind"] or dataset["access_level"] != "public":
            raise RuntimeError(f"Existing dataset metadata conflicts for {spec['name']}")
        return dataset
    response = client.post(
        "/v1/datasets",
        headers=key(),
        json={
            "city_id": CITY_ID,
            "name": spec["name"],
            "kind": spec["kind"],
            "owner": "OpenStreetMap contributors",
            "license": "ODbL-1.0",
            "access_level": "public",
            "source_uri": "https://www.openstreetmap.org/copyright",
        },
    )
    assert response.status_code == 201, response.text
    dataset = response.json()
    datasets.append(dataset)
    return dataset


def upload_and_import(client, dataset, spec):
    versions = pages(client, f"/v1/datasets/{dataset['id']}/versions")
    same = [item for item in versions if item["sha256"] == spec["sha256"]]
    if same:
        version = same[0]
        if version["status"] not in {"needs_review", "published"}:
            raise RuntimeError(f"Existing matching version is {version['status']}")
        return version
    size = spec["path"].stat().st_size
    ticket = client.post(
        f"/v1/datasets/{dataset['id']}/uploads",
        headers=key(),
        json={
            "filename": spec["path"].name,
            "content_type": "application/geo+json",
            "byte_size": size,
            "sha256": spec["sha256"],
        },
    )
    assert ticket.status_code == 201, ticket.text
    validate("UploadTicket", ticket.json())
    with spec["path"].open("rb") as stream:
        stored = client.put(
            ticket.json()["put_url"],
            headers={**key(), "Content-Type": "application/geo+json"},
            content=stream,
        )
    assert stored.status_code == 204, stored.text
    queued = client.post(
        f"/v1/datasets/{dataset['id']}/imports",
        headers=key(),
        json={
            "upload_id": ticket.json()["upload_id"],
            "format": "geojson",
            "source_crs": "EPSG:4326",
            "field_mapping": [],
            "observed_at": spec["observed_at"],
            "method": spec["method"],
            "spatial_resolution_m": None,
        },
    )
    assert queued.status_code == 202, queued.text
    job = queued.json()
    deadline = time.monotonic() + 120
    while job["state"] not in {"succeeded", "failed", "cancelled"}:
        if time.monotonic() >= deadline:
            raise TimeoutError(f"Import job {job['id']} timed out")
        time.sleep(1)
        response = client.get(f"/v1/jobs/{job['id']}")
        assert response.status_code == 200, response.text
        job = response.json()
    if job["state"] != "succeeded":
        raise RuntimeError(f"Import job failed: {job}")
    versions = pages(client, f"/v1/datasets/{dataset['id']}/versions")
    return next(item for item in versions if item["id"] == job["result_ref_id"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--base-url", default="http://localhost:8001")
    args = parser.parse_args()
    specs = layer_specs(args.manifest.resolve())
    staged = []
    with httpx.Client(base_url=args.base_url, timeout=60, follow_redirects=False) as specialist:
        login(specialist, "specialist")
        datasets = pages(specialist, "/v1/datasets", {"city_id": CITY_ID})
        for spec in specs:
            dataset = dataset_for(specialist, datasets, spec)
            version = upload_and_import(specialist, dataset, spec)
            quality = specialist.get(f"/v1/dataset-versions/{version['id']}/quality")
            assert quality.status_code == 200, quality.text
            if not quality.json()["publish_allowed"]:
                raise RuntimeError(f"Publication blocked for {spec['name']}: {quality.json()}")
            staged.append((spec, dataset, version, quality.json()))

    results = []
    with httpx.Client(base_url=args.base_url, timeout=60, follow_redirects=False) as admin:
        login(admin, "admin")
        for spec, dataset, version, quality in staged:
            if version["status"] != "published":
                response = admin.post(
                    f"/v1/dataset-versions/{version['id']}/publish",
                    headers=key(),
                    json={"reason": "Public Pavlodar working layer admitted for the hackathon"},
                )
                assert response.status_code == 200, response.text
                version = response.json()
            results.append(
                {
                    "profile": spec["profile"],
                    "dataset_id": dataset["id"],
                    "dataset_version_id": version["id"],
                    "sha256": spec["sha256"],
                    "record_count": quality["valid_count"],
                    "status": version["status"],
                }
            )
        layers = pages(admin, "/v1/map/layers", {"city_id": CITY_ID})
    result = {
        "passed": True,
        "scope": "Real public Pavlodar working layers through HTTP/outbox/worker/review/publication",
        "organizer_data_received": False,
        "official_boundary_claimed": False,
        "datasets": results,
        "published_map_layer_count": sum(
            item["dataset_version_id"] in {result["dataset_version_id"] for result in results}
            for item in layers
        ),
    }
    EVIDENCE.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
