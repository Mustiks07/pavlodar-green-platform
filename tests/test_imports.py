import hashlib
import io
import json
import math
import zipfile
from uuid import uuid4

import pytest
import shapefile
from pyproj import Transformer
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from packages.domain.contracts import validate
from services.api.db import engine, session
from services.api.models import Dataset, DatasetVersion, ImportRecord, MapLayer, Upload
from services.api.use_cases import feature_dimensions
from services.worker.imports import import_is_synthetic
from services.worker.main import run_job
from tests.test_foundation import mutation
from tools.dev.seed import CITY_ID

pytestmark = pytest.mark.integration


def test_synthetic_import_marker_is_explicit_and_anchored():
    assert import_is_synthetic(False, "SYNTHETIC TEST: estimate profile") is True
    assert import_is_synthetic(True, "ordinary city import") is True
    assert import_is_synthetic(False, "ordinary city import") is False
    assert import_is_synthetic(False, "review mentions SYNTHETIC TEST: later") is False


def test_feature_dimensions_reject_non_finite_untrusted_values():
    source = {"dataset_version_id": str(uuid4()), "source_record_id": "1"}
    for value in (True, "10", -1, float("inf"), 10**1000):
        assert feature_dimensions(
            {"height_m": value, "height_basis": "measured"}, source
        ) == (None, "unknown", None, None)


def create_dataset(
    client, *, license_name="CC0-1.0", access_level="internal", kind="green_inventory"
):
    response = mutation(
        client,
        "POST",
        "/v1/datasets",
        {
            "city_id": CITY_ID,
            "name": "SYNTHETIC TEST generic import",
            "kind": kind,
            "owner": "TEST",
            "license": license_name,
            "access_level": access_level,
            "source_uri": None,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def upload(client, dataset_id, content, content_type, filename):
    digest = hashlib.sha256(content).hexdigest()
    ticket = mutation(
        client,
        "POST",
        f"/v1/datasets/{dataset_id}/uploads",
        {
            "filename": filename,
            "content_type": content_type,
            "byte_size": len(content),
            "sha256": digest,
        },
    )
    assert ticket.status_code == 201, ticket.text
    validate("UploadTicket", ticket.json())
    stored = client.put(
        ticket.json()["put_url"],
        content=content,
        headers={"Content-Type": content_type, "Idempotency-Key": str(uuid4())},
    )
    assert stored.status_code == 204, stored.text
    return ticket.json()


def start_import(
    client,
    dataset_id,
    ticket,
    format_name,
    mapping=None,
    *,
    source_crs="EPSG:4326",
    csv_options=None,
):
    response = mutation(
        client,
        "POST",
        f"/v1/datasets/{dataset_id}/imports",
        {
            "upload_id": ticket["upload_id"],
            "format": format_name,
            "source_crs": source_crs,
            "field_mapping": mapping or [],
            "csv_options": csv_options,
            "observed_at": None,
            "method": "SYNTHETIC TEST generic import",
            "spatial_resolution_m": None,
        },
    )
    assert response.status_code == 202, response.text
    validate("Job", response.json())
    return response.json()


def geojson_bytes(*, invalid=False):
    geometry = (
        {"type": "Point", "coordinates": [999, 52.28]}
        if invalid
        else {"type": "Point", "coordinates": [76.95, 52.28]}
    )
    return json.dumps(
        {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "id": "synthetic-1",
                    "properties": {
                        "name": "SYNTHETIC TEST tree",
                        "height_m": 4.5,
                        "height_basis": "measured",
                    },
                    "geometry": geometry,
                }
            ],
        },
        separators=(",", ":"),
    ).encode()


def kml_bytes(*, entity=False):
    doctype = '<!DOCTYPE kml [<!ENTITY boom "boom">]>' if entity else ""
    name = "&boom;" if entity else "SYNTHETIC TEST tree"
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        + doctype
        + '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
        + f'<Placemark id="synthetic-kml-1"><name>{name}</name>'
        + '<ExtendedData><Data name="kind"><value>tree</value></Data></ExtendedData>'
        + '<Point><coordinates>76.95,52.28,0</coordinates></Point></Placemark>'
        + "</Document></kml>"
    ).encode()


def shp_zip_bytes(*, unsafe=False):
    if unsafe:
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("../synthetic.shp", b"x")
            archive.writestr("../synthetic.shx", b"x")
            archive.writestr("../synthetic.dbf", b"x")
        return stream.getvalue()
    shp, shx, dbf = io.BytesIO(), io.BytesIO(), io.BytesIO()
    writer = shapefile.Writer(shp=shp, shx=shx, dbf=dbf, encoding="utf-8")
    writer.field("name", "C", size=80)
    writer.point(76.96, 52.29)
    writer.record("SYNTHETIC TEST tree")
    writer.close()
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("synthetic.shp", shp.getvalue())
        archive.writestr("synthetic.shx", shx.getvalue())
        archive.writestr("synthetic.dbf", dbf.getvalue())
        archive.writestr("synthetic.cpg", "UTF-8")
    return stream.getvalue()


def tile_for(lon, lat, zoom):
    size = 2**zoom
    x = int((lon + 180) / 360 * size)
    y = int(
        (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * size
    )
    return x, y


def test_geojson_upload_queue_review_and_atomic_publish(clients):
    specialist = clients["specialist"]
    dataset = create_dataset(specialist)
    ticket = upload(
        specialist,
        dataset["id"],
        geojson_bytes(),
        "application/geo+json",
        "synthetic.geojson",
    )
    job = start_import(specialist, dataset["id"], ticket, "geojson")
    assert specialist.get(f"/v1/jobs/{job['id']}").json()["state"] == "queued"
    run_job.run(job["id"])
    completed = specialist.get(f"/v1/jobs/{job['id']}")
    assert completed.status_code == 200
    assert completed.json()["state"] == "succeeded"
    version_id = completed.json()["result_ref_id"]
    report = specialist.get(f"/v1/dataset-versions/{version_id}/quality")
    assert report.status_code == 200, report.text
    assert report.json()["publish_allowed"] is True
    assert report.json()["valid_count"] == 1 and report.json()["error_count"] == 0
    assert specialist.get(f"/v1/map/layers?city_id={CITY_ID}&limit=200").json()["items"] == []
    assert (
        mutation(
            specialist,
            "POST",
            f"/v1/dataset-versions/{version_id}/publish",
            {"reason": "SYNTHETIC TEST publish"},
        ).status_code
        == 403
    )
    published = mutation(
        clients["admin"],
        "POST",
        f"/v1/dataset-versions/{version_id}/publish",
        {"reason": "SYNTHETIC TEST reviewed"},
    )
    assert published.status_code == 200, published.text
    assert published.json()["status"] == "published"
    layers = specialist.get(f"/v1/map/layers?city_id={CITY_ID}&limit=200")
    assert layers.status_code == 200, layers.text
    assert len(layers.json()["items"]) == 1
    layer = layers.json()["items"][0]
    validate("MapLayer", layer)
    assert layer["geometry_type"] == "point"
    assert layer["source_layer"] == "features"
    assert layer["dataset_id"] == dataset["id"]
    assert layer["dataset_version_id"] == version_id
    x, y = tile_for(76.95, 52.28, 12)
    tile_url = layer["source_url"].replace("{z}", "12").replace("{x}", str(x)).replace(
        "{y}", str(y)
    )
    tile = specialist.get(tile_url)
    assert tile.status_code == 200 and tile.content
    assert tile.headers["content-type"].startswith("application/vnd.mapbox-vector-tile")
    assert tile.headers["cache-control"] == "private, max-age=60"
    unchanged = specialist.get(tile_url, headers={"If-None-Match": tile.headers["etag"]})
    assert unchanged.status_code == 304 and not unchanged.content
    with session() as db:
        feature_id = str(
            db.scalar(
                text(
                    "SELECT (md5('pavlodar:map-feature:' || version_id::text || ':' || row_index::text))::uuid FROM import_records WHERE version_id=:id"
                ),
                {"id": version_id},
            )
        )
    assert feature_id.encode() in tile.content
    feature = specialist.get(f"/v1/map/features/{feature_id}")
    assert feature.status_code == 200, feature.text
    validate("MapFeature", feature.json())
    assert feature.json()["id"] == feature_id
    assert feature.json()["dataset_version_id"] == version_id
    assert feature.json()["geometry"] == {"type": "Point", "coordinates": [76.95, 52.28]}
    assert feature.json()["source_refs"][0]["source_record_id"] == "synthetic-1"
    assert feature.json()["height_m"] == 4.5
    assert feature.json()["height_basis"] == "measured"
    assert feature.json()["height_source_ref"] == feature.json()["source_refs"][0]
    assert clients["viewer"].get(tile_url).status_code == 403
    assert clients["viewer"].get(f"/v1/map/features/{feature_id}").status_code == 403
    assert clients["outsider"].get(tile_url).status_code == 404
    assert clients["outsider"].get(f"/v1/map/features/{feature_id}").status_code == 404
    with session() as db:
        assert db.get(Dataset, dataset["id"]).current_version_id == version_id
        assert db.get(DatasetVersion, version_id).status == "published"
        assert len(list(db.scalars(select(ImportRecord)))) == 1
        assert len(list(db.scalars(select(MapLayer)))) == 1
        assert db.scalar(
            text("SELECT ST_SRID(geometry) FROM import_records WHERE version_id=:id"),
            {"id": version_id},
        ) == 4326
    with pytest.raises(DBAPIError), engine().begin() as conn:
        conn.execute(
            text("UPDATE dataset_versions SET payload=payload WHERE id=:id"), {"id": version_id}
        )


def test_upload_checksum_retry_idor_and_filename_guards(clients):
    specialist = clients["specialist"]
    dataset = create_dataset(specialist)
    content = geojson_bytes()
    ticket_response = mutation(
        specialist,
        "POST",
        f"/v1/datasets/{dataset['id']}/uploads",
        {
            "filename": "synthetic.geojson",
            "content_type": "application/geo+json",
            "byte_size": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
        },
    )
    ticket = ticket_response.json()
    wrong = specialist.put(
        ticket["put_url"],
        content=b"x" * len(content),
        headers={"Content-Type": "application/geo+json", "Idempotency-Key": str(uuid4())},
    )
    assert wrong.status_code == 422 and wrong.json()["code"] == "upload_checksum_mismatch"
    assert (
        clients["outsider"]
        .put(
            ticket["put_url"],
            content=content,
            headers={"Content-Type": "application/geo+json", "Idempotency-Key": str(uuid4())},
        )
        .status_code
        == 404
    )
    stored = specialist.put(
        ticket["put_url"],
        content=content,
        headers={"Content-Type": "application/geo+json", "Idempotency-Key": str(uuid4())},
    )
    assert stored.status_code == 204
    assert (
        specialist.put(
            ticket["put_url"],
            content=content,
            headers={"Content-Type": "application/geo+json", "Idempotency-Key": str(uuid4())},
        ).status_code
        == 204
    )
    traversal = mutation(
        specialist,
        "POST",
        f"/v1/datasets/{dataset['id']}/uploads",
        {
            "filename": "../escape.geojson",
            "content_type": "application/geo+json",
            "byte_size": 1,
            "sha256": "0" * 64,
        },
    )
    assert traversal.status_code == 422
    with session() as db:
        saved = db.get(Upload, ticket["upload_id"])
        assert saved.state == "stored" and "escape" not in saved.storage_key


def test_invalid_geojson_and_unverified_license_are_not_publishable(clients):
    specialist = clients["specialist"]
    dataset = create_dataset(specialist, license_name="unknown")
    ticket = upload(
        specialist,
        dataset["id"],
        geojson_bytes(invalid=True),
        "application/geo+json",
        "invalid.geojson",
    )
    job = start_import(specialist, dataset["id"], ticket, "geojson")
    run_job.run(job["id"])
    completed = specialist.get(f"/v1/jobs/{job['id']}").json()
    assert completed["state"] == "succeeded"
    version_id = completed["result_ref_id"]
    report = specialist.get(f"/v1/dataset-versions/{version_id}/quality").json()
    assert report["publish_allowed"] is False
    assert report["error_count"] == 1
    denied = mutation(
        clients["admin"],
        "POST",
        f"/v1/dataset-versions/{version_id}/publish",
        {"reason": "SYNTHETIC TEST should remain blocked"},
    )
    assert denied.status_code == 422
    assert denied.json()["blockers"]


def test_csv_mapping_is_persisted_without_executing_values(clients):
    specialist = clients["specialist"]
    dataset = create_dataset(specialist)
    content = b"source_name,value\r\nSYNTHETIC TEST,=2+2\r\n"
    ticket = upload(specialist, dataset["id"], content, "text/csv", "synthetic.csv")
    job = start_import(
        specialist,
        dataset["id"],
        ticket,
        "csv",
        [
            {"source_field": "source_name", "target_field": "name"},
            {"source_field": "value", "target_field": "source_value"},
        ],
    )
    run_job.run(job["id"])
    version_id = specialist.get(f"/v1/jobs/{job['id']}").json()["result_ref_id"]
    with session() as db:
        record = db.get(ImportRecord, (version_id, 0))
        version = db.get(DatasetVersion, version_id)
        assert record.payload["properties"] == {
            "name": "SYNTHETIC TEST",
            "source_value": "=2+2",
        }
        assert record.geometry is None
        assert version.payload["content_kind"] == "table"


@pytest.mark.parametrize("source_crs", ["EPSG:4326", "EPSG:32643"])
def test_csv_coordinate_mode_creates_versioned_points(clients, source_crs):
    specialist = clients["specialist"]
    dataset = create_dataset(specialist, kind="social_poi")
    lon, lat = 76.95, 52.28
    if source_crs == "EPSG:32643":
        x, y = Transformer.from_crs("EPSG:4326", source_crs, always_xy=True).transform(lon, lat)
        content = (
            "name;x;y\r\nSYNTHETIC объект;"
            f"{x:.3f}".replace(".", ",")
            + ";"
            + f"{y:.3f}".replace(".", ",")
            + "\r\n"
        ).encode("cp1251")
        options = {
            "mode": "points",
            "x_field": "x",
            "y_field": "y",
            "encoding": "windows-1251",
            "delimiter": "semicolon",
            "decimal_separator": "comma",
        }
    else:
        content = f"name,lon,lat\nSYNTHETIC object,{lon},{lat}\n".encode()
        options = {
            "mode": "points",
            "x_field": "lon",
            "y_field": "lat",
            "encoding": "utf-8",
            "delimiter": "comma",
            "decimal_separator": "dot",
        }
    ticket = upload(specialist, dataset["id"], content, "text/csv", "points.csv")
    job = start_import(
        specialist,
        dataset["id"],
        ticket,
        "csv",
        source_crs=source_crs,
        csv_options=options,
    )
    run_job.run(job["id"])
    version_id = specialist.get(f"/v1/jobs/{job['id']}").json()["result_ref_id"]
    with session() as db:
        version = db.get(DatasetVersion, version_id)
        record = db.get(ImportRecord, (version_id, 0))
        coordinates = record.payload["geometry"]["coordinates"]
        assert version.payload["content_kind"] == "vector"
        assert version.payload["import_options"] == options
        assert coordinates == pytest.approx([lon, lat], abs=0.00001)
        assert record.geometry is not None


def test_csv_coordinate_errors_are_typed_and_never_guessed(clients):
    specialist = clients["specialist"]
    dataset = create_dataset(specialist)
    content = b"name,lon,lat\nSYNTHETIC invalid,999,52.28\n"
    ticket = upload(specialist, dataset["id"], content, "text/csv", "invalid-points.csv")
    job = start_import(
        specialist,
        dataset["id"],
        ticket,
        "csv",
        csv_options={
            "mode": "points",
            "x_field": "lon",
            "y_field": "lat",
            "encoding": "utf-8",
            "delimiter": "comma",
            "decimal_separator": "dot",
        },
    )
    run_job.run(job["id"])
    version_id = specialist.get(f"/v1/jobs/{job['id']}").json()["result_ref_id"]
    report = specialist.get(f"/v1/dataset-versions/{version_id}/quality").json()
    assert report["error_count"] == 1
    assert report["issues"][0]["code"] == "csv_coordinate_invalid"


@pytest.mark.parametrize(
    ("format_name", "content_type", "filename", "content", "expected_source"),
    [
        (
            "kml",
            "application/vnd.google-earth.kml+xml",
            "synthetic.kml",
            kml_bytes(),
            "synthetic-kml-1",
        ),
        (
            "shp_zip",
            "application/zip",
            "synthetic.zip",
            shp_zip_bytes(),
            "0",
        ),
    ],
)
def test_isolated_kml_and_shapefile_imports(
    clients, format_name, content_type, filename, content, expected_source
):
    specialist = clients["specialist"]
    dataset = create_dataset(specialist)
    ticket = upload(specialist, dataset["id"], content, content_type, filename)
    job = start_import(specialist, dataset["id"], ticket, format_name)
    run_job.run(job["id"])
    completed = specialist.get(f"/v1/jobs/{job['id']}").json()
    assert completed["state"] == "succeeded"
    report = specialist.get(
        f"/v1/dataset-versions/{completed['result_ref_id']}/quality"
    ).json()
    assert report["publish_allowed"] is True
    assert report["valid_count"] == 1 and report["error_count"] == 0
    with session() as db:
        record = db.get(ImportRecord, (completed["result_ref_id"], 0))
        assert record.payload["source_record_id"] == expected_source
        assert record.payload["properties"]["name"] == "SYNTHETIC TEST tree"


@pytest.mark.parametrize(
    ("format_name", "content_type", "filename", "content", "message"),
    [
        (
            "kml",
            "application/vnd.google-earth.kml+xml",
            "entity.kml",
            kml_bytes(entity=True),
            "EntitiesForbidden",
        ),
        (
            "shp_zip",
            "application/zip",
            "unsafe.zip",
            shp_zip_bytes(unsafe=True),
            "unsafe path",
        ),
    ],
)
def test_kml_entities_and_unsafe_zip_paths_are_rejected(
    clients, format_name, content_type, filename, content, message
):
    specialist = clients["specialist"]
    dataset = create_dataset(specialist)
    ticket = upload(specialist, dataset["id"], content, content_type, filename)
    job = start_import(specialist, dataset["id"], ticket, format_name)
    run_job.run(job["id"])
    completed = specialist.get(f"/v1/jobs/{job['id']}").json()
    report = specialist.get(
        f"/v1/dataset-versions/{completed['result_ref_id']}/quality"
    ).json()
    assert report["publish_allowed"] is False and report["error_count"] == 1
    assert report["issues"][0]["code"] == "file_invalid"
    assert message in report["issues"][0]["message"]
