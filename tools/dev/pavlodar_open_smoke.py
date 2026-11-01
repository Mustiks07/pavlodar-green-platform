"""Verify the published Pavlodar working layers through the viewer API surface."""

import argparse
import hashlib
import json
import math
from pathlib import Path
from uuid import UUID

import httpx

from packages.domain.contracts import validate
from services.api.research import CITY_ID
from tools.dev.smoke_oidc import login

ROOT = Path(__file__).parents[2]
BASE = "http://localhost:8001"
IMPORT_EVIDENCE = ROOT / "docs/evidence/pavlodar_open_import.json"
LIVE_EVIDENCE = ROOT / "docs/evidence/pavlodar_open_live.json"


def feature_id(version_id: str, row_number: int = 0) -> str:
    value = hashlib.md5(
        f"pavlodar:map-feature:{version_id}:{row_number}".encode(),
        usedforsecurity=False,
    ).hexdigest()
    return str(UUID(value))


def pages(client, path, params=None):
    query = {**(params or {}), "limit": 200}
    items = []
    while True:
        response = client.get(path, params=query)
        assert response.status_code == 200, response.text
        page = response.json()
        items.extend(page["items"])
        if not page["next_cursor"]:
            return items
        query["cursor"] = page["next_cursor"]


def first_position(coordinates):
    value = coordinates
    while value and isinstance(value[0], list):
        value = value[0]
    assert len(value) >= 2
    return float(value[0]), float(value[1])


def tile_for(lon, lat, zoom=14):
    scale = 2**zoom
    x = int((lon + 180.0) / 360.0 * scale)
    latitude = math.radians(max(min(lat, 85.05112878), -85.05112878))
    y = int((1.0 - math.asinh(math.tan(latitude)) / math.pi) / 2.0 * scale)
    return zoom, x, y


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default=BASE)
    args = parser.parse_args()
    imported = json.loads(IMPORT_EVIDENCE.read_text(encoding="utf-8"))
    expected = {item["dataset_version_id"]: item for item in imported["datasets"]}
    results = []
    with httpx.Client(base_url=args.base_url, timeout=60, follow_redirects=False) as viewer:
        me = login(viewer, "viewer")
        assert CITY_ID in me["city_ids"], me
        layers = pages(viewer, "/v1/map/layers", {"city_id": CITY_ID})
        admitted = [item for item in layers if item["dataset_version_id"] in expected]
        admitted_versions = {item["dataset_version_id"] for item in admitted}
        assert admitted_versions == set(expected), {
            "missing": sorted(set(expected) - admitted_versions),
            "unexpected": sorted(admitted_versions - set(expected)),
            "visible_layer_count": len(layers),
            "visible_versions": sorted(item["dataset_version_id"] for item in layers),
        }

        for version_id, item in expected.items():
            own_layers = [layer for layer in admitted if layer["dataset_version_id"] == version_id]
            assert own_layers, item
            object_id = feature_id(version_id)
            feature = viewer.get(f"/v1/map/features/{object_id}")
            assert feature.status_code == 200, feature.text
            validate("MapFeature", feature.json())
            detail = feature.json()
            lon, lat = first_position(detail["geometry"]["coordinates"])
            zoom, x, y = tile_for(lon, lat)
            tile_bytes = 0
            for layer in own_layers:
                validate("MapLayer", layer)
                tile_url = (
                    layer["source_url"]
                    .replace("{z}", str(zoom))
                    .replace("{x}", str(x))
                    .replace("{y}", str(y))
                )
                tile = viewer.get(tile_url)
                assert tile.status_code == 200, {
                    "profile": item["profile"],
                    "layer_id": layer["id"],
                    "tile_url": tile_url,
                    "status": tile.status_code,
                    "bytes": len(tile.content),
                    "body": tile.text if tile.status_code != 200 else None,
                }
                tile_bytes += len(tile.content)
            assert tile_bytes > 0, {"profile": item["profile"], "tile": [zoom, x, y]}
            result = {
                "profile": item["profile"],
                "dataset_version_id": version_id,
                "map_layer_count": len(own_layers),
                "sample_mvt_bytes": tile_bytes,
                "sample_tile": [zoom, x, y],
                "map_feature_id": object_id,
            }
            if item["profile"] == "buildings":
                assert detail["height_m"] == 10.0, detail
                assert detail["height_basis"] == "recorded_unverified", detail
                assert detail["source_refs"][0]["source_record_id"] == "0", detail
                assert detail["height_source_ref"] == detail["source_refs"][0], detail
                result["height_m"] = detail["height_m"]
                result["height_basis"] = detail["height_basis"]
            results.append(result)

    evidence = {
        "passed": True,
        "scope": "Viewer-visible map manifests, MVT and canonical feature cards",
        "city_id": CITY_ID,
        "dataset_count": len(expected),
        "map_layer_count": len(admitted),
        "record_count": sum(item["record_count"] for item in expected.values()),
        "results": results,
    }
    LIVE_EVIDENCE.write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(evidence, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
