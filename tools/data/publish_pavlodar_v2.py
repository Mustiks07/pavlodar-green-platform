"""Import and publish the verified Pavlodar public vector package through canonical APIs.

The source package stays outside Git. This command verifies its manifest/checksums,
adds stable OSM Feature ids to derived upload files, imports every dataset into review,
and only then publishes the complete batch. Raster sources remain untouched because the
canonical API does not yet expose a COG publication pipeline.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import tempfile
import time
from pathlib import Path, PurePosixPath
from uuid import UUID, uuid4
from zipfile import ZipFile

import httpx
from shapely.geometry import shape

from packages.domain.contracts import validate
from services.api.research import CITY_ID as DEFAULT_CITY_ID
from tools.dev.smoke_oidc import login

ROOT = Path(__file__).parents[2]
DEFAULT_EVIDENCE = ROOT / "docs/evidence/pavlodar_public_v2_import.json"
OBSERVED_AT = "2026-10-28T21:21:02Z"

SPECS = (
    {
        "profile": "buildings",
        "name": "Здания Павлодара с высотой",
        "kind": "buildings",
        "sources": ("normalized/osm_buildings.geojson",),
        "stat_keys": ("buildings",),
        "families": ("polygon",),
    },
    {
        "profile": "roads",
        "name": "Дороги Павлодара",
        "kind": "roads",
        "sources": ("normalized/osm_roads.geojson",),
        "stat_keys": ("roads",),
        "families": ("line",),
    },
    {
        "profile": "green",
        "name": "Зелёные территории Павлодара",
        "kind": "green_inventory",
        "sources": ("normalized/osm_green_areas.geojson",),
        "stat_keys": ("green_areas",),
        "families": ("polygon",),
    },
    {
        "profile": "trees",
        "name": "Деревья Павлодара",
        "kind": "green_inventory",
        "sources": ("normalized/osm_trees.geojson",),
        "stat_keys": ("trees",),
        "families": ("point",),
    },
    {
        "profile": "water",
        "name": "Водные объекты Павлодара",
        "kind": "water",
        "sources": (
            "normalized/osm_water_areas.geojson",
            "normalized/osm_water_lines.geojson",
        ),
        "stat_keys": ("water_areas", "water_lines"),
        "families": ("polygon", "line"),
    },
    {
        "profile": "social_poi",
        "name": "Социальные и городские объекты Павлодара",
        "kind": "social_poi",
        "sources": (
            "normalized/osm_amenity_points.geojson",
            "normalized/osm_amenity_areas.geojson",
        ),
        "stat_keys": ("amenity_points", "amenity_areas"),
        "families": ("point", "polygon"),
    },
)


def key() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def pages(client: httpx.Client, path: str, params=None) -> list[dict]:
    params = {**(params or {}), "limit": 200}
    items = []
    while True:
        response = client.get(path, params=params)
        response.raise_for_status()
        page = response.json()
        items.extend(page["items"])
        if not page["next_cursor"]:
            return items
        params["cursor"] = page["next_cursor"]


def authenticate(client: httpx.Client, role: str) -> None:
    sessions_path = os.getenv("PG_SESSIONS")
    if sessions_path:
        sessions = json.loads(Path(sessions_path).read_text(encoding="utf-8"))
        client.cookies.set("pavlodar_session", sessions[role]["cookie"])
        response = client.get("/v1/me")
        response.raise_for_status()
        if role not in response.json()["roles"]:
            raise RuntimeError(f"Disposable session does not have {role}")
        return
    login(client, role)


def verify_documents(manifest: dict, validation: dict) -> None:
    if manifest.get("package") != "pavlodar-public-data-v2":
        raise RuntimeError(f"Unexpected source package: {manifest.get('package')!r}")
    if validation.get("status") != "pass" or validation.get("errors") or validation.get("warnings"):
        raise RuntimeError("Source package validation is not a clean pass")
    if manifest.get("working_bbox_is_official_boundary") is not False:
        raise RuntimeError("Working bbox must not be claimed as an official boundary")
    checks = validation.get("checks", {})
    if not all(
        checks.get(name) is True
        for name in (
            "osm_pbf_parsed",
            "normalized_osm_geometries_valid_nonempty",
            "normalized_osm_bounds_inside_bbox",
        )
    ):
        raise RuntimeError("Required OSM package checks did not pass")
    if checks.get("building_height_derived_from_levels") is not False:
        raise RuntimeError("Building heights derived from levels are not admitted")
    if checks.get("bbox_claimed_as_official_boundary") is not False:
        raise RuntimeError("Validation report claims an official boundary")
    osm = [item for item in manifest.get("datasets", []) if item.get("id") == "osm-pavlodar-working-bbox"]
    if len(osm) != 1 or osm[0].get("license") != "ODbL 1.0":
        raise RuntimeError("Pinned OSM dataset or ODbL licence is missing")
    if osm[0].get("version") != f"OSM data timestamp {OBSERVED_AT}":
        raise RuntimeError("Pinned OSM timestamp does not match the admitted snapshot")


def verify_package(package: Path) -> dict:
    manifest = json.loads((package / "manifest.json").read_text(encoding="utf-8"))
    validation = json.loads((package / "validation_report.json").read_text(encoding="utf-8"))
    verify_documents(manifest, validation)
    inventory = {item["path"]: item for item in manifest["file_inventory"]}
    required = {source for spec in SPECS for source in spec["sources"]}
    missing = sorted(required - inventory.keys())
    if missing:
        raise RuntimeError("Manifest does not contain required files: " + ", ".join(missing))
    for relative in sorted(required):
        path = package / relative
        item = inventory[relative]
        if not path.is_file() or path.stat().st_size != item["bytes"] or sha256(path) != item["sha256"]:
            raise RuntimeError(f"Source package file failed size/hash verification: {relative}")
    return manifest


def extract_archive(archive_path: Path, destination: Path) -> Path:
    """Extract only verified metadata and vectors; never unpack raw rasters/PBF."""
    with ZipFile(archive_path) as archive:
        manifests = [
            item
            for item in archive.infolist()
            if PurePosixPath(item.filename).name == "manifest.json"
        ]
        if len(manifests) != 1:
            raise RuntimeError(f"Archive must contain one manifest.json; found {len(manifests)}")
        root = str(PurePosixPath(manifests[0].filename).parent)

        def one(name: str):
            matches = [item for item in archive.infolist() if item.filename == name]
            if len(matches) != 1:
                raise RuntimeError(f"Archive must contain one {name}; found {len(matches)}")
            return matches[0]

        validation_info = one(f"{root}/validation_report.json")
        with archive.open(manifests[0]) as stream:
            manifest = json.load(stream)
        with archive.open(validation_info) as stream:
            validation = json.load(stream)
        verify_documents(manifest, validation)
        inventory = {item["path"]: item for item in manifest["file_inventory"]}
        required = {source for spec in SPECS for source in spec["sources"]}
        destination.mkdir(parents=True, exist_ok=True)
        (destination / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        (destination / "validation_report.json").write_text(
            json.dumps(validation, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        for relative in sorted(required):
            registered = inventory.get(relative)
            if registered is None:
                raise RuntimeError(f"Manifest does not contain required file: {relative}")
            info = one(f"{root}/{relative}")
            if info.file_size != registered["bytes"] or not (0 < info.file_size <= 50_000_000):
                raise RuntimeError(f"Archive entry has an invalid admitted size: {relative}")
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as source, target.open("wb") as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
            if sha256(target) != registered["sha256"]:
                raise RuntimeError(f"Archive entry failed checksum verification: {relative}")
    return destination


def expected_count(manifest: dict, spec: dict) -> int:
    osm = next(item for item in manifest["datasets"] if item["id"] == "osm-pavlodar-working-bbox")
    counts = [osm["stats"].get(key, {}).get("records") for key in spec["stat_keys"]]
    if any(not isinstance(value, int) or value <= 0 for value in counts):
        raise RuntimeError(f"Manifest record count is missing for {spec['profile']}")
    return sum(counts)


def stable_osm_id(properties: dict) -> str:
    osm_type, osm_id = properties.get("osm_type"), properties.get("osm_id")
    if osm_type not in {"node", "way", "relation"} or not isinstance(osm_id, int):
        raise ValueError("OSM feature is missing osm_type/osm_id")
    return f"{osm_type}/{osm_id}"


def family(geometry_type: str) -> str:
    if geometry_type in {"Polygon", "MultiPolygon"}:
        return "polygon"
    if geometry_type in {"LineString", "MultiLineString"}:
        return "line"
    if geometry_type in {"Point", "MultiPoint"}:
        return "point"
    raise ValueError(f"Unsupported map geometry family: {geometry_type}")


def prepare_spec(package: Path, work: Path, raw_spec: dict) -> dict:
    features = []
    source_ids = set()
    samples: dict[str, tuple[float, float]] = {}
    height_row = None
    for relative in raw_spec["sources"]:
        value = json.loads((package / relative).read_text(encoding="utf-8"))
        if value.get("type") != "FeatureCollection" or not isinstance(value.get("features"), list):
            raise ValueError(f"{relative} is not a FeatureCollection")
        for feature in value["features"]:
            properties = feature.get("properties")
            geometry = feature.get("geometry")
            if not isinstance(properties, dict) or not isinstance(geometry, dict):
                raise TypeError(f"{relative} contains a feature without properties/geometry")
            feature["id"] = stable_osm_id(properties)
            if feature["id"] in source_ids:
                raise ValueError(f"{relative} contains duplicate OSM identity {feature['id']}")
            source_ids.add(feature["id"])
            shaped = shape(geometry)
            if shaped.is_empty or not shaped.is_valid:
                raise ValueError(f"{relative} contains invalid geometry after package validation")
            geometry_family = family(shaped.geom_type)
            point = shaped.representative_point()
            samples.setdefault(geometry_family, (point.x, point.y))
            if raw_spec["profile"] == "buildings" and height_row is None:
                height = properties.get("height")
                try:
                    numeric_height = float(height)
                except (TypeError, ValueError):
                    numeric_height = math.nan
                if math.isfinite(numeric_height) and numeric_height > 0:
                    height_row = {
                        "row_index": len(features),
                        "source_record_id": feature["id"],
                        "height": numeric_height,
                    }
            features.append(feature)
    actual_families = tuple(sorted(samples))
    if set(actual_families) != set(raw_spec["families"]):
        raise ValueError(
            f"{raw_spec['profile']} geometry families {actual_families} do not match {raw_spec['families']}"
        )
    target = work / f"pavlodar_v2_{raw_spec['profile']}.geojson"
    target.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False, separators=(",", ":"))
        + "\n",
        encoding="utf-8",
    )
    if target.stat().st_size > 50_000_000:
        raise ValueError(f"{target.name} exceeds the canonical parser limit")
    return {
        **raw_spec,
        "path": target,
        "sha256": sha256(target),
        "feature_count": len(features),
        "samples": samples,
        "height_row": height_row,
    }


def dataset_for(client: httpx.Client, datasets: list[dict], spec: dict, city_id: str) -> dict:
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
            "city_id": city_id,
            "name": spec["name"],
            "kind": spec["kind"],
            "owner": "OpenStreetMap contributors",
            "license": "ODbL-1.0",
            "access_level": "public",
            "source_uri": "https://www.openstreetmap.org/copyright",
        },
    )
    if response.status_code != 201:
        raise RuntimeError(f"Dataset creation failed: {response.status_code} {response.text}")
    dataset = response.json()
    datasets.append(dataset)
    return dataset


def upload_and_import(client: httpx.Client, dataset: dict, spec: dict) -> tuple[dict, dict]:
    versions = pages(client, f"/v1/datasets/{dataset['id']}/versions")
    same = [item for item in versions if item["sha256"] == spec["sha256"]]
    if same:
        version = same[0]
        if version["status"] not in {"needs_review", "published"}:
            raise RuntimeError(f"Existing matching version is {version['status']}")
    else:
        ticket = client.post(
            f"/v1/datasets/{dataset['id']}/uploads",
            headers=key(),
            json={
                "filename": spec["path"].name,
                "content_type": "application/geo+json",
                "byte_size": spec["path"].stat().st_size,
                "sha256": spec["sha256"],
            },
        )
        if ticket.status_code != 201:
            raise RuntimeError(f"Upload ticket failed: {ticket.status_code} {ticket.text}")
        validate("UploadTicket", ticket.json())
        with spec["path"].open("rb") as stream:
            stored = client.put(
                ticket.json()["put_url"],
                headers={**key(), "Content-Type": "application/geo+json"},
                content=stream,
            )
        if stored.status_code != 204:
            raise RuntimeError(f"Upload failed: {stored.status_code} {stored.text}")
        queued = client.post(
            f"/v1/datasets/{dataset['id']}/imports",
            headers=key(),
            json={
                "upload_id": ticket.json()["upload_id"],
                "format": "geojson",
                "source_crs": "EPSG:4326",
                "field_mapping": [],
                "observed_at": OBSERVED_AT,
                "method": (
                    "Geofabrik Kazakhstan PBF 2026-10-28; clipped to technical Pavlodar bbox; "
                    "OSM ids/tags retained; relations assembled; no height derived from levels"
                ),
                "spatial_resolution_m": None,
            },
        )
        if queued.status_code != 202:
            raise RuntimeError(f"Import enqueue failed: {queued.status_code} {queued.text}")
        job = queued.json()
        deadline = time.monotonic() + 15 * 60
        while job["state"] not in {"succeeded", "failed", "cancelled"}:
            if time.monotonic() >= deadline:
                raise TimeoutError(f"Import job {job['id']} timed out")
            time.sleep(1)
            response = client.get(f"/v1/jobs/{job['id']}")
            response.raise_for_status()
            job = response.json()
        if job["state"] != "succeeded":
            raise RuntimeError(f"Import job failed: {job}")
        versions = pages(client, f"/v1/datasets/{dataset['id']}/versions")
        version = next(item for item in versions if item["id"] == job["result_ref_id"])
    quality_response = client.get(f"/v1/dataset-versions/{version['id']}/quality")
    quality_response.raise_for_status()
    quality = quality_response.json()
    if (
        quality["valid_count"] != spec["feature_count"]
        or quality["error_count"] != 0
        or not quality["publish_allowed"]
    ):
        raise RuntimeError(f"Publication blocked for {spec['name']}: {quality}")
    return version, quality


def tile_xy(lon: float, lat: float, zoom: int) -> tuple[int, int]:
    n = 2**zoom
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return x, y


def feature_id(version_id: str, row_index: int) -> str:
    value = f"pavlodar:map-feature:{version_id}:{row_index}".encode()
    return str(UUID(hex=hashlib.md5(value, usedforsecurity=False).hexdigest()))


def verify_publication(client: httpx.Client, staged: list[dict], city_id: str) -> list[dict]:
    layers = pages(client, "/v1/map/layers", {"city_id": city_id})
    checks = []
    for item in staged:
        spec, version = item["spec"], item["version"]
        current = [layer for layer in layers if layer["dataset_version_id"] == version["id"]]
        if {layer["geometry_type"] for layer in current} != set(spec["families"]):
            raise RuntimeError(f"Published layer families are incomplete for {spec['name']}: {current}")
        tile_results = []
        for layer in current:
            lon, lat = spec["samples"][layer["geometry_type"]]
            x, y = tile_xy(lon, lat, 14)
            url = layer["source_url"].replace("{z}", "14").replace("{x}", str(x)).replace("{y}", str(y))
            response = client.get(url)
            if response.status_code != 200 or not response.content:
                raise RuntimeError(f"Tile failed for {layer['id']}: {response.status_code}")
            tile_results.append({"layer_id": layer["id"], "geometry_type": layer["geometry_type"], "bytes": len(response.content)})
        if spec["profile"] == "buildings" and spec["height_row"] is None:
            raise RuntimeError("Building package has no positive recorded height for acceptance")
        card_row = spec["height_row"] or {"row_index": 0, "source_record_id": None}
        card_response = client.get(f"/v1/map/features/{feature_id(version['id'], card_row['row_index'])}")
        if card_response.status_code != 200:
            raise RuntimeError(f"Feature card failed for {spec['name']}: {card_response.status_code}")
        card = card_response.json()
        source_record_id = card["source_refs"][0]["source_record_id"]
        if card_row["source_record_id"] and source_record_id != card_row["source_record_id"]:
            raise RuntimeError(f"Feature lineage mismatch for {spec['name']}")
        if spec["profile"] == "buildings" and card.get("height_m") != card_row["height"]:
            raise RuntimeError(f"Recorded building height was not preserved: {card}")
        checks.append(
            {
                "profile": spec["profile"],
                "dataset_id": item["dataset"]["id"],
                "dataset_version_id": version["id"],
                "sha256": spec["sha256"],
                "record_count": spec["feature_count"],
                "status": version["status"],
                "tiles": tile_results,
                "feature_card_source_record_id": source_record_id,
                "feature_card_height_m": card.get("height_m"),
            }
        )
    return checks


def main() -> None:
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--package-root", type=Path)
    source.add_argument("--archive", type=Path)
    parser.add_argument("--base-url", default=os.getenv("PG_API_ORIGIN", "http://localhost:8001"))
    parser.add_argument("--city-id", default=os.getenv("PG_CITY_ID", DEFAULT_CITY_ID))
    parser.add_argument("--evidence", type=Path, default=DEFAULT_EVIDENCE)
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="pavlodar-v2-import-") as temporary:
        work = Path(temporary)
        package = (
            extract_archive(args.archive.resolve(), work / "package")
            if args.archive
            else args.package_root.resolve()
        )
        manifest = verify_package(package)
        manifest_sha256 = sha256(package / "manifest.json")
        specs = [prepare_spec(package, work, spec) for spec in SPECS]
        for spec in specs:
            if spec["feature_count"] != expected_count(manifest, spec):
                raise RuntimeError(f"Manifest/GeoJSON count mismatch for {spec['profile']}")
        if args.check_only:
            result = {
                "passed": True,
                "package": manifest["package"],
                "working_bbox_epsg4326": manifest["working_bbox_epsg4326"],
                "working_bbox_is_official_boundary": False,
                "observed_at": OBSERVED_AT,
                "datasets": [
                    {
                        "profile": spec["profile"],
                        "feature_count": spec["feature_count"],
                        "sha256": spec["sha256"],
                        "geometry_families": spec["families"],
                    }
                    for spec in specs
                ],
                "total_feature_count": sum(spec["feature_count"] for spec in specs),
                "writes_performed": False,
            }
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return
        staged = []
        with httpx.Client(base_url=args.base_url, timeout=180, follow_redirects=False) as specialist:
            authenticate(specialist, "specialist")
            datasets = pages(specialist, "/v1/datasets", {"city_id": args.city_id})
            for spec in specs:
                dataset = dataset_for(specialist, datasets, spec, args.city_id)
                version, quality = upload_and_import(specialist, dataset, spec)
                staged.append({"spec": spec, "dataset": dataset, "version": version, "quality": quality})

        with httpx.Client(base_url=args.base_url, timeout=180, follow_redirects=False) as admin:
            authenticate(admin, "admin")
            for item in staged:
                if item["version"]["status"] != "published":
                    response = admin.post(
                        f"/v1/dataset-versions/{item['version']['id']}/publish",
                        headers=key(),
                        json={"reason": "Verified public Pavlodar OSM package v2, dated 2026-10-28"},
                    )
                    if response.status_code != 200:
                        raise RuntimeError(f"Publication failed: {response.status_code} {response.text}")
                    item["version"] = response.json()

        with httpx.Client(base_url=args.base_url, timeout=180, follow_redirects=False) as viewer:
            authenticate(viewer, "viewer")
            checks = verify_publication(viewer, staged, args.city_id)

    evidence = {
        "passed": True,
        "scope": "Verified public Pavlodar v2 vectors through HTTP/upload/worker/review/publication/MVT/card",
        "package_manifest_sha256": manifest_sha256,
        "working_bbox_epsg4326": manifest["working_bbox_epsg4326"],
        "working_bbox_is_official_boundary": False,
        "organizer_data_received": False,
        "height_from_levels": False,
        "datasets": checks,
        "raster_status": {
            "available_in_package": ["WorldCover", "Copernicus DEM", "SoilGrids", "JRC Global Surface Water"],
            "published": False,
            "reason": "Canonical API has no COG/raster publication pipeline yet",
        },
    }
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    args.evidence.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(evidence, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
