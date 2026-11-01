"""Bounded GeoJSON/CSV validation into immutable review records; no network or code execution."""

import csv
import hashlib
import json
import math
from datetime import UTC, datetime

from geoalchemy2.shape import from_shape
from jsonschema import ValidationError
from shapely.geometry import shape

from packages.domain.contracts import validate
from packages.domain.errors import DomainError, gap
from services.api.models import (
    AuditEvent,
    City,
    Dataset,
    DatasetVersion,
    ImportQuality,
    ImportRecord,
    Upload,
)
from services.api.uploads import upload_path
from services.api.use_cases import found, now, uid
from services.worker.import_parsers import parse_isolated

MAX_PARSE_BYTES = 50_000_000
MAX_RECORDS = 100_000
MAX_ISSUES = 10_000
SYNTHETIC_METHOD_PREFIX = "SYNTHETIC TEST:"


def import_is_synthetic(city_synthetic, method):
    """Admit explicit prototype inputs without reclassifying ordinary city imports.

    The marker is intentionally exact and anchored at the beginning of ``method``.  A source note
    that merely mentions synthetic data later in the text must not silently change provenance.
    """
    return bool(city_synthetic) or method.startswith(SYNTHETIC_METHOD_PREFIX)


def issue(code, message, source=None, severity="error", action=None, geometry=None):
    return {
        "code": code,
        "severity": severity,
        "source_record_id": source,
        "message": message,
        "geometry": geometry,
        "suggested_action": action,
    }


def mapping(request, fields):
    pairs = request["field_mapping"]
    sources = [pair["source_field"] for pair in pairs]
    targets = [pair["target_field"] for pair in pairs]
    if len(sources) != len(set(sources)) or len(targets) != len(set(targets)):
        raise ValueError("field_mapping contains duplicate source or target fields")
    missing = sorted(set(sources) - set(fields))
    if missing:
        raise ValueError("field_mapping source fields missing: " + ", ".join(missing))
    return pairs


def mapped(properties, pairs):
    if not pairs:
        return properties
    return {pair["target_field"]: properties.get(pair["source_field"]) for pair in pairs}


def parse_geojson(path, request):
    if request["source_crs"].upper() not in {"EPSG:4326", "CRS84", "OGC:CRS84"}:
        return [], [
            issue(
                "crs_transform_not_available",
                "Первый инкремент GeoJSON принимает только WGS84; преобразование CRS не выполнялось",
                action="Предоставьте EPSG:4326 или дождитесь изолированного transform pipeline",
            )
        ]
    with path.open("r", encoding="utf-8-sig") as stream:
        value = json.load(
            stream,
            parse_constant=lambda token: (_ for _ in ()).throw(ValueError(token)),
        )
    if not isinstance(value, dict) or value.get("type") != "FeatureCollection":
        raise ValueError("GeoJSON root must be FeatureCollection")
    features = value.get("features")
    if not isinstance(features, list):
        raise TypeError("FeatureCollection.features must be an array")
    if len(features) > MAX_RECORDS:
        raise ValueError(f"GeoJSON exceeds {MAX_RECORDS} features")
    property_fields = {
        key
        for feature in features
        if isinstance(feature, dict) and isinstance(feature.get("properties"), dict)
        for key in feature["properties"]
    }
    pairs = mapping(request, property_fields)
    records, issues = [], []
    for index, feature in enumerate(features):
        source = str(feature.get("id", index)) if isinstance(feature, dict) else str(index)
        try:
            if not isinstance(feature, dict) or feature.get("type") != "Feature":
                raise ValueError("record is not a GeoJSON Feature")
            properties = feature.get("properties")
            geometry = feature.get("geometry")
            if not isinstance(properties, dict) or geometry is None:
                raise ValueError("feature properties or geometry is missing")
            validate("Geometry", geometry)
            shaped = shape(geometry)
            if shaped.is_empty or not shaped.is_valid:
                raise ValueError("geometry is empty or topologically invalid")
            west, south, east, north = shaped.bounds
            if not all(math.isfinite(value) for value in shaped.bounds) or not (
                -180 <= west <= east <= 180 and -90 <= south <= north <= 90
            ):
                raise ValueError("geometry coordinates are outside EPSG:4326 bounds")
            records.append(
                {
                    "source_record_id": source,
                    "geometry": geometry,
                    "properties": mapped(properties, pairs),
                }
            )
        except (ValueError, ValidationError) as error:
            if len(issues) < MAX_ISSUES:
                issues.append(
                    issue(
                        "record_invalid",
                        f"Запись {source} не прошла проверку: {error.message if isinstance(error, ValidationError) else str(error)}",
                        source,
                    )
                )
    return records, issues


def parse_csv(path, request):
    csv.field_size_limit(1_000_000)
    records, issues = [], []
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        if not reader.fieldnames:
            raise ValueError("CSV header is missing")
        pairs = mapping(request, reader.fieldnames)
        for index, row in enumerate(reader):
            if index >= MAX_RECORDS:
                raise ValueError(f"CSV exceeds {MAX_RECORDS} records")
            if None in row:
                if len(issues) < MAX_ISSUES:
                    issues.append(issue("csv_column_count", "В строке лишние значения", str(index)))
                continue
            records.append(
                {
                    "source_record_id": str(index),
                    "geometry": None,
                    "properties": mapped(row, pairs),
                }
            )
    return records, issues


def checked_file(upload):
    path = upload_path(upload.storage_key)
    if not path.is_file() or path.stat().st_size != upload.byte_size:
        raise DomainError(503, "upload_storage_missing", "Stored upload is missing or truncated")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != upload.sha256:
        raise DomainError(503, "upload_storage_corrupt", "Stored upload checksum changed")
    return path


def persist_import(db, job):
    upload = found(db.get(Upload, job.input_ref_id))
    dataset = found(db.get(Dataset, upload.dataset_id))
    if upload.import_job_id != job.id or not upload.import_request:
        raise DomainError(409, "job_input_invalid", "Upload is not bound to this import job")
    path = checked_file(upload)
    request = upload.import_request
    records, issues = [], []
    if upload.byte_size > MAX_PARSE_BYTES:
        issues.append(
            issue(
                "parser_size_limit",
                f"Парсер ограничен {MAX_PARSE_BYTES} байт на файл",
                action="Разделите файл на версионированные части",
            )
        )
    else:
        try:
            if request["format"] == "geojson":
                records, issues = parse_geojson(path, request)
            elif request["format"] == "csv":
                records, issues = parse_csv(path, request)
            elif request["format"] in {"kml", "shp_zip"}:
                records, issues = parse_isolated(path, request)
            else:
                issues.append(
                    issue(
                        "parser_not_available",
                        f"Изолированный parser {request['format']} ещё не подключён",
                        action="Преобразуйте файл в GeoJSON или CSV и загрузите повторно",
                    )
                )
        except (ValueError, TypeError, UnicodeError, csv.Error, json.JSONDecodeError) as error:
            issues.append(issue("file_invalid", f"Файл не прошёл разбор: {error!s}"))

    issues_truncated = len(issues) > MAX_ISSUES
    total_errors = sum(item["severity"] == "error" for item in issues)
    total_warnings = len(issues) - total_errors
    issues = issues[:MAX_ISSUES]

    license_unverified = dataset.payload["license"].strip().lower() in {
        "unknown",
        "неизвестно",
        "unverified",
    }
    if license_unverified:
        issues.append(
            issue(
                "license_unverified",
                "Лицензия источника не подтверждена",
                severity="warning",
                action="Указать и проверить условия использования до публикации",
            )
        )
    errors = total_errors
    version_id, report_id = uid(), uid()
    created_at = now()
    observed_date = request["observed_at"][:10] if request["observed_at"] else None
    status = "rejected" if errors else "needs_review"
    if errors:
        readiness = "load_failed"
    elif not records:
        readiness = "provided_empty"
    else:
        readiness = "available"
    blockers = []
    if errors:
        blockers.append(gap("import_validation_failed", "Импорт содержит ошибки", upload.id))
    else:
        blockers.append(
            gap("import_review_required", "Версия ожидает проверки администратора", version_id)
        )
    if license_unverified:
        blockers.append(gap("license_review_required", "Лицензия не подтверждена", "DR-07"))
    version = {
        "id": version_id,
        "dataset_id": dataset.id,
        "status": status,
        "sha256": upload.sha256,
        "observed_at": request["observed_at"],
        "created_at": created_at,
        "source_crs": request["source_crs"],
        "method": request["method"],
        "quality_report_id": report_id,
        "published_at": None,
        "readiness_state": readiness,
        "content_kind": "table" if request["format"] == "csv" else "vector",
        "record_count": len(records),
        "checked_at": datetime.now(UTC).date().isoformat(),
        "observed_from": observed_date,
        "observed_to": observed_date,
        "applicability": "Ожидает проверки администратора" if not errors else "Файл отклонён проверкой",
        "data_request_id": None,
        "review_reasons": blockers,
    }
    report = {
        "id": report_id,
        "dataset_version_id": version_id,
        "record_count": len(records) + errors,
        "valid_count": len(records),
        "error_count": errors,
        "warning_count": total_warnings,
        "issues": issues,
        "issues_truncated": issues_truncated,
        "issues_next_cursor": None,
        "publish_allowed": errors == 0 and not license_unverified,
    }
    validate("DatasetVersion", version)
    validate("QualityReport", report)
    city = found(db.get(City, dataset.city_id))
    db.add(
        DatasetVersion(
            id=version_id,
            dataset_id=dataset.id,
            status=status,
            payload=version,
            synthetic=import_is_synthetic(city.synthetic, request["method"]),
        )
    )
    db.flush()
    for index, record in enumerate(records):
        geometry = shape(record["geometry"]) if record["geometry"] is not None else None
        db.add(
            ImportRecord(
                version_id=version_id,
                row_index=index,
                payload=record,
                geometry=from_shape(geometry, srid=4326) if geometry is not None else None,
            )
        )
    db.add(ImportQuality(version_id=version_id, upload_id=upload.id, payload=report))
    event_id = uid()
    db.add(
        AuditEvent(
            id=event_id,
            actor_id=job.owner_id,
            payload={
                "id": event_id,
                "actor_id": job.owner_id,
                "action": "import.validated",
                "object_id": version_id,
                "object_type": "DatasetVersion",
                "occurred_at": created_at,
                "reason": f"status={status}; errors={errors}; warnings={total_warnings}",
            },
        )
    )
    return version_id
