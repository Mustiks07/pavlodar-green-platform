"""Reviewed delivery adapter, not a generic uploader or a canonical catalog publisher."""

import base64
import hashlib
import json
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from uuid import UUID, uuid5

from jsonschema import Draft202012Validator
from sqlalchemy import select, text

from packages.domain.contracts import validate
from packages.domain.errors import DomainError, gap
from services.api.models import (
    AuditEvent,
    City,
    CityGrant,
    Dataset,
    DatasetVersion,
    Principal,
    ResearchFile,
    ResearchQuality,
    ResearchReceipt,
    StagingIdentity,
    StagingOccurrence,
    StagingRecord,
)
from services.api.use_cases import canonical_hash

NAMESPACE = UUID("27c4dc01-72b1-4630-861f-165704ac481b")
ACCEPTED_MANIFEST = "eac58412633c8f054287be45ed6f6a901e9884ffbd5ab3ade6a771db53b3798e"
DELIVERY_COMMIT = "21b7d88"


def identity(value):
    return str(uuid5(NAMESPACE, value))


CITY_ID = identity("city:pavlodar")


def verified_files(root: Path):
    """No network, symlink traversal, unlisted files, PDF import, or supplied code execution."""
    root = root.resolve()
    manifest_bytes = (root / "research/data/manifest.json").read_bytes()
    receipt_id = hashlib.sha256(manifest_bytes).hexdigest()
    if receipt_id != ACCEPTED_MANIFEST:
        raise ValueError("Unreviewed delivery manifest; review a new adapter version first")
    manifest = json.loads(manifest_bytes)
    files = {}
    for entry in manifest["files"]:
        path = entry["path"]
        # Planning/handoffs are intentionally merged independently, not used as data.
        if not path.startswith("research/data/"):
            continue
        local = (root / path).resolve()
        if not local.is_relative_to(root / "research/data") or local.suffix.lower() == ".pdf":
            raise ValueError("Disallowed delivery path")
        content = local.read_bytes()
        if len(content) != entry["bytes"] or hashlib.sha256(content).hexdigest() != entry["sha256"]:
            raise ValueError("Delivery checksum mismatch: " + path)
        files[path] = content
    for i in range(1, 8):
        prefix = f"research/data/DR-{i:02}/"
        Draft202012Validator(json.loads(files[prefix + "schema.json"])).validate(
            json.loads(files[prefix + "records.json"])
        )
    return receipt_id, manifest, files


def interpret(table, raw):
    result = {"adapter_version": "research-staging-1", "canonical_promotion": "not_approved"}
    if table == "traits.csv" and raw["unit"] == "ft":
        result["conversion"] = {
            "from_unit": "ft",
            "to_unit": "m",
            "factor": "0.3048",
            "formula": "original * 0.3048 (international foot)",
            **{
                key: None if raw[key] is None else str(Decimal(str(raw[key])) * Decimal("0.3048"))
                for key in ["lower", "upper"]
            },
        }
        result["growth_curve_available"] = False
    if table == "plants.csv":
        result.update(
            eligibility="needs_review", safety_verified=False, legal_prohibition_established=False
        )
    if table == "stock.csv":
        result.update(
            local_quote=raw["supplier_city"] == "Павлодар",
            inventory_verified=False,
            reservable=False,
            quantity_state="unknown"
            if raw["quantity"] is None
            else ("reported_zero" if raw["quantity"] == 0 else "supplier_declared"),
        )
    if table in {"rates.csv", "rules.csv"}:
        result["active_for_calculation"] = False
    if table == "reported_events.csv":
        result["training_eligible"] = False
    return result


def row_key(dr, table, raw):
    if table == "sources.csv":
        return "source", raw["source_id"]
    if table == "stock.csv":
        return "stock", raw["stock_id"]  # DR-02/05 are two occurrences of ONE quote.
    if table == "plants.csv":
        return "taxon", raw["taxon_id"]
    if table.endswith(".geojson"):
        props = raw.get("properties", {})
        return dr + ":" + table, props.get("object_id", props.get("osm_id", canonical_hash(raw)))
    keys = [
        "record_id",
        "rule_id",
        "rate_id",
        "event_id",
        "scene_id",
        "search_id",
        "dataset_id",
        "source_id",
    ]
    key = next((str(raw[k]) for k in keys if raw.get(k) is not None), canonical_hash(raw))
    return dr + ":" + table, key


def store_record(db, dr, table, raw):
    namespace, external = row_key(dr, table, raw)
    entity_id = identity(namespace + ":" + external)
    if not db.get(StagingIdentity, entity_id):
        db.add(StagingIdentity(id=entity_id, namespace=namespace, external_id=external))
        db.flush()
    sha = canonical_hash(raw)
    record_id = identity(entity_id + ":" + sha)
    if not db.get(StagingRecord, record_id):
        db.add(
            StagingRecord(
                id=record_id,
                identity_id=entity_id,
                sha256=sha,
                raw=raw,
                interpretation=interpret(table, raw),
            )
        )
        db.flush()
    return record_id


def issue(code, message, source=None, action=None):
    return {
        "code": code,
        "severity": "warning",
        "source_record_id": source,
        "message": message,
        "geometry": None,
        "suggested_action": action,
    }


def import_delivery(db, root, actor_id, grant_users=()):
    receipt_id, manifest, files = verified_files(Path(root))
    actor = db.get(Principal, actor_id)
    if not actor or not actor.active or "admin" not in actor.roles:
        raise DomainError(403, "admin_required", "An active administrator must own the import")
    # Serializes concurrent deliveries and shared identities across API/CLI processes.
    db.execute(text("SELECT pg_advisory_xact_lock(492270329036)"))
    users = {actor_id, *grant_users}
    for user_id in users:
        user = db.get(Principal, user_id)
        if not user or not user.active:
            raise ValueError("Unknown or inactive grant recipient")
    if db.get(ResearchReceipt, receipt_id):
        for user_id in users:
            if not db.get(CityGrant, (user_id, CITY_ID)):
                db.add(CityGrant(user_id=user_id, city_id=CITY_ID))
        return {"receipt_id": receipt_id, "city_id": CITY_ID, "created": False}
    timestamp = datetime.now(UTC)
    created_at = timestamp.isoformat().replace("+00:00", "Z")
    version_ids = {f"DR-{i:02}": identity(receipt_id + f":DR-{i:02}") for i in range(1, 8)}
    if not db.get(City, CITY_ID):
        boundary = json.loads(files["research/data/DR-01/working_boundary.geojson"])
        city = {
            "id": CITY_ID,
            "name": "Павлодар — рабочий контур OSM",
            "timezone": "Asia/Almaty",
            "metric_crs": "EPSG:32643",
            "boundary": boundary["features"][0]["geometry"],
            "boundary_status": "working",
            "boundary_version_id": version_ids["DR-01"],
        }
        validate("City", city)
        db.add(City(id=CITY_ID, payload=city, synthetic=False))
        db.flush()
    for user_id in users:
        if not db.get(CityGrant, (user_id, CITY_ID)):
            db.add(CityGrant(user_id=user_id, city_id=CITY_ID))
    db.add(
        ResearchReceipt(
            id=receipt_id,
            actor_id=actor_id,
            city_id=CITY_ID,
            created_at=timestamp,
            manifest=manifest,
        )
    )
    db.flush()
    for path, content in files.items():
        db.add(
            ResearchFile(
                receipt_id=receipt_id,
                path=path,
                content=content,
                sha256=hashlib.sha256(content).hexdigest(),
            )
        )
    kinds = ["boundary", "catalog", "restrictions", "observations", "rates", "weather", "catalog"]
    names = [
        "Рабочая граница OSM",
        "Кандидаты растений и предложения",
        "Нормы и пробелы ограничений",
        "Сообщения о посадках — без наблюдений",
        "Котировки — неполная смета",
        "OSM, ERA5 и метаданные Sentinel",
        "Лицензии и решения владельца",
    ]
    content_kinds = ["vector", "table", "legal_text", "table", "table", "mixed", "table"]
    applicability = [
        "Рабочая граница OSM; не официальная граница организатора",
        "Исследовательские кандидаты и предложения; требуется локальная экспертиза",
        "Тексты и пробелы норм; не автоматический правовой вывод",
        "Набор не содержит наблюдаемых когорт для локальной survival-калибровки",
        "Неполные котировки; не итоговая смета и не подтверждённый прайс",
        "110 зданий, одна ячейка ERA5 и каталог Sentinel; не полный городской растр",
        "Источники и решения владельца ещё не подтверждены",
    ]
    for i in range(1, 8):
        dr = f"DR-{i:02}"
        prefix = "research/data/" + dr + "/"
        tables = json.loads(files[prefix + "records.json"])
        quality = json.loads(files[prefix + "quality.json"])
        count = sum(len(v) for k, v in tables.items() if k != "sources.csv")
        dataset_id = identity("dataset:" + dr)
        version_id = version_ids[dr]
        report_id = identity(version_id + ":quality")
        if not db.get(Dataset, dataset_id):
            dataset = {
                "id": dataset_id,
                "city_id": CITY_ID,
                "name": dr + " · " + names[i - 1],
                "kind": kinds[i - 1],
                "owner": "Исследовательский пакет 2026-10-29",
                "license": "Разные лицензии; условия и источники в отчёте качества",
                "access_level": "internal",
                "current_version_id": None,
                "source_uri": f"https://github.com/AIFESTHackathon2026/team-vtiposhnik/tree/{DELIVERY_COMMIT}/{prefix}",
                "created_at": created_at,
            }
            validate("Dataset", dataset)
            db.add(
                Dataset(
                    id=dataset_id,
                    city_id=CITY_ID,
                    owner_id=actor_id,
                    access_level="internal",
                    payload=dataset,
                )
            )
            db.flush()
        version = {
            "id": version_id,
            "dataset_id": dataset_id,
            "status": "needs_review",
            "sha256": hashlib.sha256(files[prefix + "records.json"]).hexdigest(),
            "observed_at": None,
            "created_at": created_at,
            "source_crs": "mixed; see original schemas and per-source metadata",
            "method": "research-staging-1; checked 2026-10-29; not published or expert approved",
            "quality_report_id": report_id,
            "published_at": None,
            "readiness_state": "research_unverified",
            "content_kind": content_kinds[i - 1],
            "record_count": count,
            "checked_at": "2026-10-29",
            "observed_from": None,
            "observed_to": None,
            "applicability": applicability[i - 1],
            "data_request_id": dr,
            "review_reasons": [
                gap(
                    "research_not_approved",
                    "Исследовательский источник не принят владельцем и профильным экспертом",
                    dr,
                )
            ],
        }
        validate("DatasetVersion", version)
        db.add(
            DatasetVersion(
                id=version_id,
                dataset_id=dataset_id,
                status="needs_review",
                payload=version,
                synthetic=False,
            )
        )
        db.flush()
        sources = {
            r["source_id"]: store_record(db, dr, "sources.csv", r) for r in tables["sources.csv"]
        }
        for table, rows in tables.items():
            for row_index, raw in enumerate(rows):
                refs = [raw["source_id"]] if raw.get("source_id") else []
                refs += raw.get("source_refs", "").split(";") if raw.get("source_refs") else []
                # sources.csv is itself a source version, not a self-citing measurement.
                source_ids = [] if table == "sources.csv" else [sources[r] for r in refs]
                db.add(
                    StagingOccurrence(
                        version_id=version_id,
                        table_name=table,
                        row_index=row_index,
                        record_id=store_record(db, dr, table, raw),
                        source_record_ids=source_ids,
                    )
                )
        for filename in quality.get("geometry_files", {}):
            collection = json.loads(files[prefix + filename])
            for row_index, feature in enumerate(collection["features"]):
                source_id = feature.get("properties", {}).get("source_id", "OSM")
                db.add(
                    StagingOccurrence(
                        version_id=version_id,
                        table_name=filename,
                        row_index=row_index,
                        record_id=store_record(db, dr, filename, feature),
                        source_record_ids=[sources[source_id]],
                    )
                )
        issues = [
            issue("research_not_approved", text, dr, "Ответ владельца / экспертная проверка")
            for text in quality["limitations"]
        ]
        for source in tables["sources.csv"]:
            issues.append(
                issue(
                    "source_provenance", json.dumps(source, ensure_ascii=False), source["source_id"]
                )
            )
        report = {
            "id": report_id,
            "dataset_version_id": version_id,
            "record_count": count,
            "valid_count": count,
            "error_count": 0,
            "warning_count": len(issues),
            "issues": issues,
            "issues_truncated": False,
            "issues_next_cursor": None,
            "publish_allowed": False,
        }
        validate("QualityReport", report)
        db.add(
            ResearchQuality(
                version_id=version_id, receipt_id=receipt_id, request_id=dr, payload=report
            )
        )
        event_id = identity(receipt_id + ":audit:" + dr)
        db.add(
            AuditEvent(
                id=event_id,
                actor_id=actor_id,
                payload={
                    "id": event_id,
                    "actor_id": actor_id,
                    "action": "research.staged",
                    "object_id": dataset_id,
                    "object_type": "Dataset",
                    "occurred_at": created_at,
                    "reason": "Checksum-verified delivery; canonical promotion and acceptance remain blocked",
                },
            )
        )
    db.flush()
    return {
        "receipt_id": receipt_id,
        "city_id": CITY_ID,
        "created": True,
        "dataset_versions": version_ids,
        "archived_files": len(files),
    }


def publication_blockers():
    return [
        gap(
            "research_not_approved",
            "Structural validation is not expert or owner acceptance",
            "DR-01",
            "DR-02",
            "DR-03",
            "DR-05",
            "DR-07",
        )
    ]


def quality_page(report, params, user_id):
    limit, offset = int(params.get("limit", 50)), 0
    context = canonical_hash({"report": report["id"], "limit": limit, "user": user_id})
    if params.get("cursor"):
        try:
            cursor = json.loads(base64.urlsafe_b64decode(params["cursor"]))
            offset = cursor["offset"]
            if (
                cursor["context"] != context
                or type(offset) is not int
                or not 0 <= offset < len(report["issues"])
            ):
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            raise DomainError(
                422, "invalid_cursor", "Cursor does not match this quality report"
            ) from None
    end = offset + limit
    more = end < len(report["issues"])
    cursor = (
        base64.urlsafe_b64encode(json.dumps({"offset": end, "context": context}).encode()).decode()
        if more
        else None
    )
    return {
        **report,
        "issues": report["issues"][offset:end],
        "issues_truncated": more,
        "issues_next_cursor": cursor,
    }


def source_versions(db, city_id):
    return list(
        db.scalars(
            select(DatasetVersion)
            .join(Dataset, DatasetVersion.dataset_id == Dataset.id)
            .join(ResearchQuality, ResearchQuality.version_id == DatasetVersion.id)
            .where(Dataset.city_id == city_id)
        )
    )
