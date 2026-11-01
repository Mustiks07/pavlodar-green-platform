"""Immutable, source-backed ecological coefficient registry."""

from datetime import UTC, datetime

from sqlalchemy import select

from packages.domain.contracts import validate
from packages.domain.errors import DomainError
from services.api.models import (
    CoefficientIdentity,
    CoefficientVersionRecord,
    Dataset,
    DatasetVersion,
    ImportRecord,
)


def _canonical_sources(db, access, source_refs):
    if not source_refs:
        raise DomainError(
            422, "coefficient_source_invalid", "Coefficient requires published source records"
        )
    version_ids = {item["dataset_version_id"] for item in source_refs}
    if len(version_ids) != 1:
        raise DomainError(
            422,
            "coefficient_source_invalid",
            "One coefficient version uses one dataset version",
        )
    version = db.get(DatasetVersion, next(iter(version_ids)))
    if version is None or version.status != "published":
        raise DomainError(
            422, "coefficient_source_invalid", "Coefficient source is not published"
        )
    dataset = db.get(Dataset, version.dataset_id)
    access.dataset(dataset)
    canonical, seen = [], set()
    for supplied in source_refs:
        source_record_id = supplied["source_record_id"]
        if source_record_id is None or source_record_id in seen:
            raise DomainError(
                422,
                "coefficient_source_invalid",
                "Coefficient source records must be present and unique",
            )
        exists = db.scalar(
            select(ImportRecord.row_index).where(
                ImportRecord.version_id == version.id,
                ImportRecord.payload["source_record_id"].astext == source_record_id,
            )
        )
        if exists is None:
            raise DomainError(
                422, "coefficient_source_invalid", "Coefficient source record was not found"
            )
        seen.add(source_record_id)
        canonical.append(
            {
                "dataset_version_id": version.id,
                "source_record_id": source_record_id,
                "label": dataset.payload["name"],
                "uri": dataset.payload["source_uri"],
            }
        )
    return canonical, dataset, version


def create_coefficient_version(db, access, body, *, uid):
    sources, dataset, version = _canonical_sources(db, access, body["source_refs"])
    coefficient_id, version_id = uid(), uid()
    payload = {
        "id": coefficient_id,
        "version_id": version_id,
        **body,
        "source_refs": sources,
    }
    validate("Coefficient", payload)
    db.add(CoefficientIdentity(id=coefficient_id))
    db.flush()
    db.add(
        CoefficientVersionRecord(
            id=version_id,
            coefficient_id=coefficient_id,
            city_id=dataset.city_id,
            dataset_id=dataset.id,
            dataset_version_id=version.id,
            actor_id=access.user.id,
            created_at=datetime.now(UTC),
            payload=payload,
        )
    )
    return payload


def authorize_coefficient(db, access, version_id, *, city_id=None, usable=False):
    coefficient = db.get(CoefficientVersionRecord, version_id)
    if coefficient is None:
        raise DomainError(404, "not_found", "Coefficient version was not found")
    access.dataset(db.get(Dataset, coefficient.dataset_id))
    if city_id is not None and coefficient.city_id != city_id:
        raise DomainError(
            422, "coefficient_version_unavailable", "Coefficient belongs to another city"
        )
    if usable and coefficient.payload["expert_status"] != "approved":
        raise DomainError(
            422,
            "coefficient_version_unavailable",
            "Only an approved coefficient can be frozen in a scenario",
        )
    return coefficient
