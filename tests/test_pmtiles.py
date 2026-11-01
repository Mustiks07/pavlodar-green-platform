import hashlib

import pytest
from pmtiles.reader import MemorySource, Reader
from pmtiles.tile import TileType
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from services.api.config import settings
from services.api.db import session
from services.api.models import MapArchiveArtifact
from services.api.tiles import simplification_tolerance
from services.worker.main import run_job
from services.worker.pmtiles import ArchiveBuildError, _tile_ranges, build_archive, register_archive
from tests.test_foundation import mutation
from tests.test_imports import create_dataset, geojson_bytes, start_import, tile_for, upload

pytestmark = pytest.mark.integration


@pytest.fixture
def archive_root(monkeypatch, tmp_path):
    monkeypatch.setenv("PAVLODAR_TILE_ROOT", str(tmp_path))
    settings.cache_clear()
    yield tmp_path
    settings.cache_clear()


def publish_synthetic_public_point(clients):
    specialist = clients["specialist"]
    dataset = create_dataset(specialist, access_level="public")
    ticket = upload(
        specialist,
        dataset["id"],
        geojson_bytes(),
        "application/geo+json",
        "synthetic-pmtiles.geojson",
    )
    job = start_import(specialist, dataset["id"], ticket, "geojson")
    run_job.run(job["id"])
    completed = specialist.get(f"/v1/jobs/{job['id']}").json()
    published = mutation(
        clients["admin"],
        "POST",
        f"/v1/dataset-versions/{completed['result_ref_id']}/publish",
        {"reason": "SYNTHETIC TEST PMTiles publication"},
    )
    assert published.status_code == 200, published.text
    layers = specialist.get(f"/v1/map/layers?city_id={dataset['city_id']}&limit=200").json()
    return next(item for item in layers["items"] if item["dataset_id"] == dataset["id"])


def test_pmtiles_builder_matches_authorized_mvt_and_is_deterministic(clients, tmp_path):
    layer = publish_synthetic_public_point(clients)
    first_path = tmp_path / "first.pmtiles"
    second_path = tmp_path / "second.pmtiles"
    with session() as db:
        first = build_archive(db, layer["id"], first_path, min_zoom=10, max_zoom=12)
        second = build_archive(db, layer["id"], second_path, min_zoom=10, max_zoom=12)

    assert first.tile_count == 3 and first.candidate_tile_count == 3
    assert first.sha256 == second.sha256
    assert first.sha256 == hashlib.sha256(first_path.read_bytes()).hexdigest()
    assert first_path.read_bytes() == second_path.read_bytes()

    x, y = tile_for(76.95, 52.28, 12)
    dynamic_url = (
        layer["source_url"].replace("{z}", "12").replace("{x}", str(x)).replace("{y}", str(y))
    )
    dynamic_tile = clients["specialist"].get(dynamic_url)
    assert dynamic_tile.status_code == 200 and dynamic_tile.content
    reader = Reader(MemorySource(first_path.read_bytes()))
    header = reader.header()
    metadata = reader.metadata()
    assert header["version"] == 3
    assert header["tile_type"] == TileType.MVT
    assert header["min_zoom"] == 10 and header["max_zoom"] == 12
    assert metadata["vector_layers"] == [{"id": "features", "fields": {}}]
    assert reader.get(12, x, y) == dynamic_tile.content

    with session() as db, db.begin():
        db.execute(
            text("UPDATE datasets SET access_level='internal' WHERE id=:dataset_id"),
            {"dataset_id": layer["dataset_id"]},
        )
    protected_path = tmp_path / "protected.pmtiles"
    with session() as db, pytest.raises(ArchiveBuildError) as protected:
        build_archive(db, layer["id"], protected_path, min_zoom=10, max_zoom=12)
    assert protected.value.code == "pmtiles_protected_layer"
    assert not protected_path.exists()


def test_pmtiles_candidate_limit_fails_before_writing(clients, tmp_path):
    layer = publish_synthetic_public_point(clients)
    destination = tmp_path / "must-not-exist.pmtiles"
    with session() as db, pytest.raises(ArchiveBuildError) as raised:
        build_archive(
            db,
            layer["id"],
            destination,
            min_zoom=10,
            max_zoom=12,
            max_candidate_tiles=2,
        )
    assert raised.value.code == "pmtiles_candidate_limit"
    assert not destination.exists()


def test_registered_archive_range_delivery_and_manifest_promotion(clients, archive_root):
    layer = publish_synthetic_public_point(clients)
    with session() as db, db.begin():
        built = register_archive(
            db, layer["id"], archive_root, min_zoom=10, max_zoom=12
        )
    expected = built.path.read_bytes()
    with session() as db:
        replay = register_archive(db, layer["id"], archive_root, min_zoom=10, max_zoom=12)
        assert replay.sha256 == built.sha256
        with pytest.raises(ArchiveBuildError) as conflict:
            register_archive(db, layer["id"], archive_root, min_zoom=9, max_zoom=12)
        assert conflict.value.code == "pmtiles_artifact_conflict"

    listed = clients["viewer"].get(
        f"/v1/map/layers?city_id={layer['city_id']}&limit=200"
    )
    promoted = next(item for item in listed.json()["items"] if item["id"] == layer["id"])
    assert promoted["source_type"] == "pmtiles"
    assert promoted["source_url"] == f"/v1/map/archives/{layer['id']}.pmtiles"
    assert (promoted["min_zoom"], promoted["max_zoom"]) == (10, 12)

    url = promoted["source_url"]
    first = clients["viewer"].get(url, headers={"Range": "bytes=0-126"})
    assert first.status_code == 206 and first.content == expected[:127]
    assert first.headers["content-range"] == f"bytes 0-126/{len(expected)}"
    assert first.headers["accept-ranges"] == "bytes"
    assert first.headers["content-type"].startswith("application/vnd.pmtiles")
    etag = first.headers["etag"]

    suffix = clients["viewer"].get(url, headers={"Range": "bytes=-32"})
    assert suffix.status_code == 206 and suffix.content == expected[-32:]
    full = clients["viewer"].get(
        url, headers={"Range": "bytes=0-31", "If-Range": '"different"'}
    )
    assert full.status_code == 200 and full.content == expected
    assert clients["viewer"].get(url, headers={"If-None-Match": etag}).status_code == 304

    invalid = clients["viewer"].get(url, headers={"Range": f"bytes={len(expected)}-"})
    assert invalid.status_code == 416
    assert invalid.headers["content-range"] == f"bytes */{len(expected)}"
    assert invalid.json()["code"] == "range_not_satisfiable"
    too_long = clients["viewer"].get(url, headers={"Range": "bytes=" + "9" * 129 + "-"})
    assert too_long.status_code == 416
    assert clients["outsider"].get(url).status_code == 404

    with session() as db:
        artifact = db.scalar(
            select(MapArchiveArtifact).where(MapArchiveArtifact.map_layer_id == layer["id"])
        )
        assert artifact.sha256 == hashlib.sha256(expected).hexdigest()
    with pytest.raises(DBAPIError), session() as db, db.begin():
        db.execute(
            text("UPDATE map_archive_artifacts SET byte_size=byte_size WHERE map_layer_id=:id"),
            {"id": layer["id"]},
        )


def test_tile_ranges_are_bounded_and_zoom_ordered():
    ranges = list(_tile_ranges((76.949, 52.279, 76.951, 52.281), 5, 8))
    assert [item[0] for item in ranges] == [5, 6, 7, 8]
    assert len(set(ranges)) == len(ranges)
    assert simplification_tolerance(5) > simplification_tolerance(10)
    assert simplification_tolerance(10) == pytest.approx(152.8740565703525)
