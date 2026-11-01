import hashlib
import json
from zipfile import ZIP_DEFLATED, ZipFile

import pytest

from tools.data.publish_pavlodar_v2 import (
    OBSERVED_AT,
    SPECS,
    expected_count,
    extract_archive,
    prepare_spec,
    stable_osm_id,
    verify_package,
)


def geometry(profile, source_index):
    if profile == "roads" or (profile == "water" and source_index == 1):
        return {"type": "LineString", "coordinates": [[76.95, 52.28], [76.96, 52.29]]}
    if (
        profile in {"buildings", "green"}
        or (profile == "water" and source_index == 0)
        or (profile == "social_poi" and source_index == 1)
    ):
        return {
            "type": "Polygon",
            "coordinates": [[[76.95, 52.28], [76.96, 52.28], [76.96, 52.29], [76.95, 52.28]]],
        }
    return {"type": "Point", "coordinates": [76.95, 52.28]}


def package_archive(tmp_path, *, corrupt=False):
    root = "run-test"
    files = {}
    stats = {}
    osm_id = 0
    for spec in SPECS:
        for source_index, (source, stat_key) in enumerate(zip(spec["sources"], spec["stat_keys"], strict=True)):
            osm_id += 1
            feature = {
                "type": "Feature",
                "properties": {"osm_type": "way", "osm_id": osm_id},
                "geometry": geometry(spec["profile"], source_index),
            }
            content = json.dumps(
                {"type": "FeatureCollection", "features": [feature]}, separators=(",", ":")
            ).encode()
            files[source] = content
            stats[stat_key] = {"records": 1}
    inventory = [
        {"path": path, "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
        for path, content in files.items()
    ]
    if corrupt:
        inventory[0]["sha256"] = "0" * 64
    manifest = {
        "package": "pavlodar-public-data-v2",
        "working_bbox_epsg4326": [76.86, 52.2, 77.2, 52.4],
        "working_bbox_is_official_boundary": False,
        "datasets": [
            {
                "id": "osm-pavlodar-working-bbox",
                "license": "ODbL 1.0",
                "version": f"OSM data timestamp {OBSERVED_AT}",
                "stats": stats,
            }
        ],
        "file_inventory": inventory,
    }
    validation = {
        "status": "pass",
        "errors": [],
        "warnings": [],
        "checks": {
            "osm_pbf_parsed": True,
            "normalized_osm_geometries_valid_nonempty": True,
            "normalized_osm_bounds_inside_bbox": True,
            "building_height_derived_from_levels": False,
            "bbox_claimed_as_official_boundary": False,
        },
    }
    path = tmp_path / "package.zip"
    with ZipFile(path, "w", ZIP_DEFLATED) as archive:
        archive.writestr(f"{root}/manifest.json", json.dumps(manifest))
        archive.writestr(f"{root}/validation_report.json", json.dumps(validation))
        for name, content in files.items():
            archive.writestr(f"{root}/{name}", content)
    return path


def test_verified_archive_prepares_stable_combined_datasets(tmp_path):
    package = extract_archive(package_archive(tmp_path), tmp_path / "extracted")
    manifest = verify_package(package)
    prepared = [prepare_spec(package, tmp_path, spec) for spec in SPECS]

    assert sum(spec["feature_count"] for spec in prepared) == 8
    assert [expected_count(manifest, spec) for spec in prepared] == [1, 1, 1, 1, 2, 2]
    water = json.loads((tmp_path / "pavlodar_v2_water.geojson").read_text(encoding="utf-8"))
    assert [feature["id"] for feature in water["features"]] == ["way/5", "way/6"]
    assert not (package / "raw").exists()


def test_archive_checksum_mismatch_is_rejected(tmp_path):
    with pytest.raises(RuntimeError, match="checksum verification"):
        extract_archive(package_archive(tmp_path, corrupt=True), tmp_path / "extracted")


def test_osm_identity_requires_type_and_integer_id():
    assert stable_osm_id({"osm_type": "relation", "osm_id": 42}) == "relation/42"
    with pytest.raises(ValueError, match="missing osm_type/osm_id"):
        stable_osm_id({"osm_type": "way", "osm_id": "42"})
