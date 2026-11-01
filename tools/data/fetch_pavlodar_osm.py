"""Fetch bounded Pavlodar OSM working layers through Overpass and emit reviewed GeoJSON inputs."""

import argparse
import hashlib
import json
import math
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx
from shapely.geometry import shape

ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)
BBOX = (52.1931974, 76.8599921, 52.4503782, 77.2048261)  # south, west, north, east
MAX_RESPONSE_BYTES = 128 * 1024 * 1024
MAX_FEATURES = 20_000
USER_AGENT = (
    "team-vtiposhnik-hackathon/1.0 "
    "(https://github.com/AIFESTHackathon2026/team-vtiposhnik)"
)

PROFILES = {
    "roads": {
        "kind": "roads",
        "selectors": ['way["highway"]'],
        "geometry": "line",
    },
    "green": {
        "kind": "green_inventory",
        "selectors": [
            'way["leisure"="park"]',
            'way["landuse"~"^(forest|grass|meadow|recreation_ground|village_green)$"]',
            'way["natural"~"^(wood|grassland|scrub)$"]',
        ],
        "geometry": "polygon",
    },
    "trees": {
        "kind": "green_inventory",
        "selectors": ['node["natural"="tree"]'],
        "geometry": "point",
    },
    "water": {
        "kind": "water",
        "selectors": [
            'way["natural"="water"]',
            'way["waterway"]',
        ],
        "geometry": "mixed",
    },
}

TAG_KEYS = {
    "name",
    "name:kk",
    "name:ru",
    "highway",
    "surface",
    "lanes",
    "maxspeed",
    "leisure",
    "landuse",
    "natural",
    "water",
    "waterway",
    "species",
    "species:ru",
    "genus",
    "height",
    "circumference",
    "start_date",
}


def query(profile):
    south, west, north, east = BBOX
    bbox = f"({south},{west},{north},{east})"
    selectors = "\n".join(f"  {selector}{bbox};" for selector in profile["selectors"])
    return (
        "[out:json][timeout:180][maxsize:134217728];\n"
        "(\n"
        f"{selectors}\n"
        ");\n"
        "out tags geom;\n"
    )


def _coordinates(element):
    if element["type"] == "node":
        return [element["lon"], element["lat"]]
    return [[point["lon"], point["lat"]] for point in element.get("geometry", [])]


def convert_elements(elements, geometry_mode):
    features = []
    for element in elements:
        element_type = element.get("type")
        if element_type not in {"node", "way"} or "id" not in element:
            continue
        coordinates = _coordinates(element)
        if element_type == "node":
            if geometry_mode != "point":
                continue
            geometry = {"type": "Point", "coordinates": coordinates}
        else:
            if len(coordinates) < 2:
                continue
            closed = len(coordinates) >= 4 and coordinates[0] == coordinates[-1]
            if geometry_mode == "polygon":
                if not closed:
                    continue
                geometry = {"type": "Polygon", "coordinates": [coordinates]}
            elif geometry_mode == "line":
                geometry = {"type": "LineString", "coordinates": coordinates}
            elif closed:
                geometry = {"type": "Polygon", "coordinates": [coordinates]}
            else:
                geometry = {"type": "LineString", "coordinates": coordinates}
        tags = element.get("tags", {})
        shaped = shape(geometry)
        if shaped.is_empty or not shaped.is_valid or not all(
            math.isfinite(value) for value in shaped.bounds
        ):
            continue
        properties = {
            "object_id": f"{element_type}/{element['id']}",
            **{key: tags[key] for key in sorted(TAG_KEYS) if key in tags},
        }
        features.append(
            {
                "type": "Feature",
                "id": properties["object_id"],
                "properties": properties,
                "geometry": geometry,
            }
        )
        if len(features) > MAX_FEATURES:
            raise ValueError(f"Profile exceeds the bounded limit of {MAX_FEATURES} features")
    return features


def fetch(client, overpass_query):
    last_error = None
    for endpoint in ENDPOINTS:
        for attempt in range(2):
            try:
                with client.stream("POST", endpoint, data={"data": overpass_query}) as response:
                    if response.status_code in {429, 502, 503, 504}:
                        last_error = RuntimeError(
                            f"Overpass {endpoint} returned {response.status_code}"
                        )
                    else:
                        response.raise_for_status()
                        chunks, size = [], 0
                        for chunk in response.iter_bytes():
                            size += len(chunk)
                            if size > MAX_RESPONSE_BYTES:
                                raise ValueError("Overpass response exceeds 128 MiB")
                            chunks.append(chunk)
                        return json.loads(b"".join(chunks)), endpoint
            except (httpx.HTTPError, json.JSONDecodeError) as error:
                last_error = error
            if attempt == 0:
                time.sleep(2)
    raise RuntimeError(f"All bounded Overpass endpoints failed: {last_error}")


def write_profile(output_dir, name, payload, overpass_query, endpoint):
    profile = PROFILES[name]
    features = convert_elements(payload.get("elements", []), profile["geometry"])
    observed_at = payload.get("osm3s", {}).get("timestamp_osm_base")
    collection = {"type": "FeatureCollection", "features": features}
    encoded = (json.dumps(collection, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    target = output_dir / f"pavlodar_osm_{name}.geojson"
    if target.exists():
        raise FileExistsError(f"Refusing to overwrite {target}; use a fresh output directory")
    target.write_bytes(encoded)
    return {
        "profile": name,
        "kind": profile["kind"],
        "path": target.as_posix(),
        "feature_count": len(features),
        "rejected_or_unsupported_count": len(payload.get("elements", [])) - len(features),
        "sha256": hashlib.sha256(encoded).hexdigest(),
        "bytes": len(encoded),
        "observed_at": observed_at,
        "endpoint": endpoint,
        "query_sha256": hashlib.sha256(overpass_query.encode()).hexdigest(),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--profile", action="append", choices=sorted(PROFILES))
    args = parser.parse_args()
    selected = args.profile or list(PROFILES)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    results = []
    with httpx.Client(
        timeout=httpx.Timeout(210, connect=20),
        follow_redirects=False,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    ) as client:
        for name in selected:
            overpass_query = query(PROFILES[name])
            payload, endpoint = fetch(client, overpass_query)
            results.append(
                write_profile(args.output_dir, name, payload, overpass_query, endpoint)
            )
    manifest = {
        "generated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "scope": "Pavlodar working bbox; not an official municipal boundary",
        "bbox_south_west_north_east": list(BBOX),
        "allowed_endpoints": list(ENDPOINTS),
        "license": "ODbL-1.0",
        "attribution": "© OpenStreetMap contributors",
        "source_uri": "https://www.openstreetmap.org/copyright",
        "layers": results,
    }
    manifest_path = args.output_dir / "manifest.json"
    if manifest_path.exists():
        raise FileExistsError(f"Refusing to overwrite {manifest_path}")
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
