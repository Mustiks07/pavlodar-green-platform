"""Normalized identities and references; immutable contract payloads are stored as JSONB."""

from datetime import date, datetime
from typing import Any

from geoalchemy2 import Geometry
from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class City(Base):
    __tablename__ = "cities"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    payload: Mapped[dict] = mapped_column(JSONB)
    synthetic: Mapped[bool] = mapped_column(Boolean, default=False)


class Principal(Base):
    __tablename__ = "principals"
    __table_args__ = (UniqueConstraint("issuer", "subject"),)
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    issuer: Mapped[str] = mapped_column(String)
    subject: Mapped[str] = mapped_column(String)
    display_name: Mapped[str] = mapped_column(String)
    roles: Mapped[list] = mapped_column(JSONB)
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class CityGrant(Base):
    __tablename__ = "city_grants"
    user_id: Mapped[str] = mapped_column(ForeignKey("principals.id"), primary_key=True)
    city_id: Mapped[str] = mapped_column(ForeignKey("cities.id"), primary_key=True)


class WebSession(Base):
    __tablename__ = "web_sessions"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("principals.id"))
    csrf_token: Mapped[str] = mapped_column(String)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    encrypted_provider_tokens: Mapped[str | None] = mapped_column(String)


class LoginState(Base):
    __tablename__ = "login_states"
    state_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    browser_hash: Mapped[str] = mapped_column(String(64))
    nonce: Mapped[str] = mapped_column(String)
    verifier: Mapped[str] = mapped_column(String)
    return_to: Mapped[str] = mapped_column(String)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Dataset(Base):
    __tablename__ = "datasets"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    city_id: Mapped[str] = mapped_column(ForeignKey("cities.id"), index=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("principals.id"))
    access_level: Mapped[str] = mapped_column(String)
    current_version_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False))
    payload: Mapped[dict] = mapped_column(JSONB)


class DatasetGrant(Base):
    __tablename__ = "dataset_grants"
    user_id: Mapped[str] = mapped_column(ForeignKey("principals.id"), primary_key=True)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), primary_key=True)


class DatasetVersion(Base):
    __tablename__ = "dataset_versions"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), index=True)
    status: Mapped[str] = mapped_column(String)
    payload: Mapped[dict] = mapped_column(JSONB)
    synthetic: Mapped[bool] = mapped_column(Boolean, default=False)


class Upload(Base):
    __tablename__ = "uploads"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), index=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("principals.id"))
    filename: Mapped[str] = mapped_column(String)
    content_type: Mapped[str] = mapped_column(String)
    byte_size: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64))
    state: Mapped[str] = mapped_column(String, index=True)
    storage_key: Mapped[str] = mapped_column(String, unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    stored_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    import_job_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False))
    import_request: Mapped[dict | None] = mapped_column(JSONB)


class ImportRecord(Base):
    __tablename__ = "import_records"
    version_id: Mapped[str] = mapped_column(ForeignKey("dataset_versions.id"), primary_key=True)
    row_index: Mapped[int] = mapped_column(Integer, primary_key=True)
    payload: Mapped[dict] = mapped_column(JSONB)
    geometry: Mapped[Any | None] = mapped_column(Geometry("GEOMETRY", srid=4326))


class ImportQuality(Base):
    __tablename__ = "import_quality"
    version_id: Mapped[str] = mapped_column(ForeignKey("dataset_versions.id"), primary_key=True)
    upload_id: Mapped[str] = mapped_column(ForeignKey("uploads.id"), unique=True)
    payload: Mapped[dict] = mapped_column(JSONB)


class MapLayer(Base):
    __tablename__ = "map_layers"
    __table_args__ = (UniqueConstraint("dataset_version_id", "geometry_type"),)
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    city_id: Mapped[str] = mapped_column(ForeignKey("cities.id"), index=True)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), index=True)
    dataset_version_id: Mapped[str] = mapped_column(
        ForeignKey("dataset_versions.id"), index=True
    )
    geometry_type: Mapped[str] = mapped_column(String)
    payload: Mapped[dict] = mapped_column(JSONB)


class MapArchiveArtifact(Base):
    __tablename__ = "map_archive_artifacts"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    map_layer_id: Mapped[str] = mapped_column(ForeignKey("map_layers.id"), unique=True)
    dataset_version_id: Mapped[str] = mapped_column(
        ForeignKey("dataset_versions.id"), index=True
    )
    storage_key: Mapped[str] = mapped_column(String, unique=True)
    sha256: Mapped[str] = mapped_column(String(64))
    byte_size: Mapped[int] = mapped_column(Integer)
    tile_count: Mapped[int] = mapped_column(Integer)
    candidate_tile_count: Mapped[int] = mapped_column(Integer)
    min_zoom: Mapped[int] = mapped_column(Integer)
    max_zoom: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AddressEntry(Base):
    __tablename__ = "address_entries"
    __table_args__ = (UniqueConstraint("dataset_version_id", "row_index"),)
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    city_id: Mapped[str] = mapped_column(ForeignKey("cities.id"), index=True)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), index=True)
    dataset_version_id: Mapped[str] = mapped_column(
        ForeignKey("dataset_versions.id"), index=True
    )
    row_index: Mapped[int] = mapped_column(Integer)
    source_record_id: Mapped[str | None] = mapped_column(String)
    label: Mapped[str] = mapped_column(String)
    search_text: Mapped[str] = mapped_column(String)
    confidence: Mapped[str] = mapped_column(String)
    position: Mapped[Any] = mapped_column(Geometry("POINT", srid=4326))


class PlantIdentity(Base):
    __tablename__ = "plant_identities"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)


class CatalogVersion(Base):
    __tablename__ = "catalog_versions"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    actor_id: Mapped[str] = mapped_column(ForeignKey("principals.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    synthetic: Mapped[bool] = mapped_column(Boolean, default=False)
    payload: Mapped[dict] = mapped_column(JSONB)


class CatalogState(Base):
    __tablename__ = "catalog_state"
    key: Mapped[str] = mapped_column(String, primary_key=True)
    current_version_id: Mapped[str | None] = mapped_column(ForeignKey("catalog_versions.id"))


class PlantVersion(Base):
    __tablename__ = "plant_versions"
    catalog_version_id: Mapped[str] = mapped_column(
        ForeignKey("catalog_versions.id"), primary_key=True
    )
    plant_id: Mapped[str] = mapped_column(ForeignKey("plant_identities.id"), primary_key=True)
    payload: Mapped[dict] = mapped_column(JSONB)


class RuleVersionRecord(Base):
    __tablename__ = "rule_versions"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), index=True)
    dataset_version_id: Mapped[str] = mapped_column(
        ForeignKey("dataset_versions.id"), index=True
    )
    payload: Mapped[dict] = mapped_column(JSONB)


class StockItemRecord(Base):
    __tablename__ = "stock_item_versions"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    plant_id: Mapped[str] = mapped_column(ForeignKey("plant_identities.id"), index=True)
    city_id: Mapped[str] = mapped_column(ForeignKey("cities.id"), index=True)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), index=True)
    dataset_version_id: Mapped[str] = mapped_column(
        ForeignKey("dataset_versions.id"), index=True
    )
    payload: Mapped[dict] = mapped_column(JSONB)


class SurvivalModelRecord(Base):
    __tablename__ = "survival_model_versions"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    city_id: Mapped[str] = mapped_column(ForeignKey("cities.id"), index=True)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), index=True)
    dataset_version_id: Mapped[str] = mapped_column(
        ForeignKey("dataset_versions.id"), index=True
    )
    payload: Mapped[dict] = mapped_column(JSONB)


class RateIdentity(Base):
    __tablename__ = "rate_identities"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)


class RateVersionRecord(Base):
    __tablename__ = "rate_versions"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    rate_id: Mapped[str] = mapped_column(ForeignKey("rate_identities.id"), index=True)
    city_id: Mapped[str] = mapped_column(ForeignKey("cities.id"), index=True)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), index=True)
    dataset_version_id: Mapped[str] = mapped_column(
        ForeignKey("dataset_versions.id"), index=True
    )
    actor_id: Mapped[str] = mapped_column(ForeignKey("principals.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    payload: Mapped[dict] = mapped_column(JSONB)


class CoefficientIdentity(Base):
    __tablename__ = "coefficient_identities"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)


class CoefficientVersionRecord(Base):
    __tablename__ = "coefficient_versions"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    coefficient_id: Mapped[str] = mapped_column(
        ForeignKey("coefficient_identities.id"), index=True
    )
    city_id: Mapped[str] = mapped_column(ForeignKey("cities.id"), index=True)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), index=True)
    dataset_version_id: Mapped[str] = mapped_column(
        ForeignKey("dataset_versions.id"), index=True
    )
    actor_id: Mapped[str] = mapped_column(ForeignKey("principals.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    payload: Mapped[dict] = mapped_column(JSONB)


class CalculationSnapshotRecord(Base):
    __tablename__ = "calculation_snapshots"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    scenario_revision_id: Mapped[str] = mapped_column(
        ForeignKey("scenario_revisions.id"), index=True
    )
    actor_id: Mapped[str] = mapped_column(ForeignKey("principals.id"))
    input_hash: Mapped[str] = mapped_column(String(64), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    payload: Mapped[dict] = mapped_column(JSONB)
    manifest: Mapped[dict] = mapped_column(JSONB)


class PriorityResultRecord(Base):
    __tablename__ = "priority_results"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    city_id: Mapped[str] = mapped_column(ForeignKey("cities.id"), index=True)
    actor_id: Mapped[str] = mapped_column(ForeignKey("principals.id"))
    normalization_version_id: Mapped[str] = mapped_column(Uuid(as_uuid=False), index=True)
    payload: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class SpatialResultRecord(Base):
    __tablename__ = "spatial_results"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    scenario_revision_id: Mapped[str] = mapped_column(
        ForeignKey("scenario_revisions.id"), index=True
    )
    city_id: Mapped[str] = mapped_column(ForeignKey("cities.id"), index=True)
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id"), unique=True)
    kind: Mapped[str] = mapped_column(String)
    payload: Mapped[dict] = mapped_column(JSONB)
    artifact: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Zone(Base):
    __tablename__ = "zones"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    city_id: Mapped[str] = mapped_column(ForeignKey("cities.id"), index=True)
    current_version_id: Mapped[str] = mapped_column(Uuid(as_uuid=False))


class ZoneVersion(Base):
    __tablename__ = "zone_versions"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    zone_id: Mapped[str] = mapped_column(ForeignKey("zones.id"), index=True)
    payload: Mapped[dict] = mapped_column(JSONB)
    synthetic: Mapped[bool] = mapped_column(Boolean, default=False)


class ProblemDecisionRecord(Base):
    __tablename__ = "problem_decisions"
    problem_id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    zone_id: Mapped[str] = mapped_column(ForeignKey("zones.id"), index=True)
    actor_id: Mapped[str] = mapped_column(ForeignKey("principals.id"))
    status: Mapped[str] = mapped_column(String)
    reason: Mapped[str] = mapped_column(String)
    decided_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Scenario(Base):
    __tablename__ = "scenarios"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    city_id: Mapped[str] = mapped_column(ForeignKey("cities.id"), index=True)
    zone_id: Mapped[str] = mapped_column(ForeignKey("zones.id"), index=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("principals.id"))
    status: Mapped[str] = mapped_column(String, default="draft")
    current_revision_id: Mapped[str] = mapped_column(Uuid(as_uuid=False))
    payload: Mapped[dict] = mapped_column(JSONB)


class ScenarioRevision(Base):
    __tablename__ = "scenario_revisions"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    scenario_id: Mapped[str] = mapped_column(ForeignKey("scenarios.id"), index=True)
    zone_version_id: Mapped[str] = mapped_column(ForeignKey("zone_versions.id"))
    parent_revision_id: Mapped[str | None] = mapped_column(ForeignKey("scenario_revisions.id"))
    payload: Mapped[dict] = mapped_column(JSONB)


class Program(Base):
    __tablename__ = "programs"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    city_id: Mapped[str] = mapped_column(ForeignKey("cities.id"), index=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("principals.id"))
    status: Mapped[str] = mapped_column(String, default="draft")
    current_input_version_id: Mapped[str] = mapped_column(Uuid(as_uuid=False))
    current_revision_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False))
    payload: Mapped[dict] = mapped_column(JSONB)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ProgramInputVersion(Base):
    __tablename__ = "program_input_versions"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    program_id: Mapped[str] = mapped_column(ForeignKey("programs.id"), index=True)
    parent_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False))
    actor_id: Mapped[str] = mapped_column(ForeignKey("principals.id"))
    priority_result_id: Mapped[str | None] = mapped_column(ForeignKey("priority_results.id"))
    payload: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ProgramInputCandidate(Base):
    __tablename__ = "program_input_candidates"
    input_version_id: Mapped[str] = mapped_column(
        ForeignKey("program_input_versions.id"), primary_key=True
    )
    scenario_revision_id: Mapped[str] = mapped_column(
        ForeignKey("scenario_revisions.id"), primary_key=True
    )


class ProgramRevisionRecord(Base):
    __tablename__ = "program_revisions"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    program_id: Mapped[str] = mapped_column(ForeignKey("programs.id"), index=True)
    input_version_id: Mapped[str] = mapped_column(ForeignKey("program_input_versions.id"))
    job_id: Mapped[str | None] = mapped_column(ForeignKey("jobs.id"), unique=True)
    payload: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ProgramRevisionCalculation(Base):
    __tablename__ = "program_revision_calculations"
    program_revision_id: Mapped[str] = mapped_column(
        ForeignKey("program_revisions.id"), primary_key=True
    )
    calculation_snapshot_id: Mapped[str] = mapped_column(
        ForeignKey("calculation_snapshots.id"), primary_key=True
    )


class ExportArtifactRecord(Base):
    __tablename__ = "export_artifacts"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id"), unique=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("principals.id"))
    city_id: Mapped[str] = mapped_column(ForeignKey("cities.id"), index=True)
    target_kind: Mapped[str] = mapped_column(String)
    target_id: Mapped[str] = mapped_column(Uuid(as_uuid=False), index=True)
    format: Mapped[str] = mapped_column(String)
    storage_key: Mapped[str] = mapped_column(String, unique=True)
    sha256: Mapped[str] = mapped_column(String(64))
    byte_size: Mapped[int] = mapped_column(BigInteger)
    media_type: Mapped[str] = mapped_column(String)
    filename: Mapped[str] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ChatSessionRecord(Base):
    __tablename__ = "chat_sessions"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    city_id: Mapped[str] = mapped_column(ForeignKey("cities.id"), index=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("principals.id"), index=True)
    zone_id: Mapped[str | None] = mapped_column(ForeignKey("zones.id"))
    scenario_revision_id: Mapped[str | None] = mapped_column(
        ForeignKey("scenario_revisions.id")
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ChatMessageRecord(Base):
    __tablename__ = "chat_messages"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("chat_sessions.id"), index=True)
    job_id: Mapped[str | None] = mapped_column(ForeignKey("jobs.id"), unique=True)
    role: Mapped[str] = mapped_column(String)
    state: Mapped[str] = mapped_column(String)
    text: Mapped[str] = mapped_column(String)
    facts: Mapped[list] = mapped_column(JSONB)
    proposal_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False))
    provider: Mapped[str | None] = mapped_column(String)
    model: Mapped[str | None] = mapped_column(String)
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ProposalRecord(Base):
    __tablename__ = "proposals"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    scenario_id: Mapped[str] = mapped_column(ForeignKey("scenarios.id"), index=True)
    base_revision_id: Mapped[str] = mapped_column(
        ForeignKey("scenario_revisions.id"), index=True
    )
    owner_id: Mapped[str] = mapped_column(ForeignKey("principals.id"), index=True)
    assistant_message_id: Mapped[str] = mapped_column(
        ForeignKey("chat_messages.id"), unique=True
    )
    status: Mapped[str] = mapped_column(String)
    summary: Mapped[str] = mapped_column(String)
    proposed_revision: Mapped[dict] = mapped_column(JSONB)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decision_reason: Mapped[str | None] = mapped_column(String)


class WorkOrderRecord(Base):
    __tablename__ = "work_orders"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    city_id: Mapped[str] = mapped_column(ForeignKey("cities.id"), index=True)
    zone_id: Mapped[str] = mapped_column(ForeignKey("zones.id"), index=True)
    scenario_revision_id: Mapped[str] = mapped_column(
        ForeignKey("scenario_revisions.id"), index=True
    )
    care_operation_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False))
    resource_period: Mapped[str | None] = mapped_column(String)
    owner_id: Mapped[str] = mapped_column(ForeignKey("principals.id"))
    status: Mapped[str] = mapped_column(String)
    payload: Mapped[dict] = mapped_column(JSONB)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class WorkOrderStatusEvent(Base):
    __tablename__ = "work_order_status_events"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    work_order_id: Mapped[str] = mapped_column(ForeignKey("work_orders.id"), index=True)
    actor_id: Mapped[str] = mapped_column(ForeignKey("principals.id"))
    payload: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class WorkCompletionRecord(Base):
    __tablename__ = "work_completions"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    work_order_id: Mapped[str] = mapped_column(ForeignKey("work_orders.id"), index=True)
    correction_of_id: Mapped[str | None] = mapped_column(
        ForeignKey("work_completions.id"), unique=True
    )
    actor_id: Mapped[str] = mapped_column(ForeignKey("principals.id"))
    payload: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class CohortRecord(Base):
    __tablename__ = "cohorts"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    city_id: Mapped[str] = mapped_column(ForeignKey("cities.id"), index=True)
    zone_id: Mapped[str] = mapped_column(ForeignKey("zones.id"), index=True)
    plant_id: Mapped[str] = mapped_column(ForeignKey("plant_identities.id"))
    placement_id: Mapped[str] = mapped_column(Uuid(as_uuid=False), index=True)
    initial_quantity: Mapped[int] = mapped_column(Integer)
    planting_date: Mapped[date] = mapped_column(Date)
    replaces_cohort_id: Mapped[str | None] = mapped_column(ForeignKey("cohorts.id"))
    source_work_order_id: Mapped[str] = mapped_column(
        ForeignKey("work_orders.id"), unique=True
    )
    latest_inspection_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False))


class InspectionRecord(Base):
    __tablename__ = "inspections"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    city_id: Mapped[str] = mapped_column(ForeignKey("cities.id"), index=True)
    zone_id: Mapped[str] = mapped_column(ForeignKey("zones.id"), index=True)
    cohort_id: Mapped[str] = mapped_column(ForeignKey("cohorts.id"), index=True)
    actor_id: Mapped[str] = mapped_column(ForeignKey("principals.id"))
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    payload: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class RevisionDataset(Base):
    __tablename__ = "revision_datasets"
    revision_id: Mapped[str] = mapped_column(ForeignKey("scenario_revisions.id"), primary_key=True)
    version_id: Mapped[str] = mapped_column(ForeignKey("dataset_versions.id"), primary_key=True)


class Idempotency(Base):
    __tablename__ = "idempotency"
    scope: Mapped[str] = mapped_column(String(64), primary_key=True)
    request_hash: Mapped[str] = mapped_column(String(64))
    status: Mapped[int] = mapped_column(Integer)
    response: Mapped[dict | None] = mapped_column(JSONB)
    headers: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    actor_id: Mapped[str] = mapped_column(ForeignKey("principals.id"))
    payload: Mapped[dict] = mapped_column(JSONB)


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("principals.id"))
    city_id: Mapped[str] = mapped_column(ForeignKey("cities.id"), index=True)
    input_revision_id: Mapped[str | None] = mapped_column(ForeignKey("scenario_revisions.id"))
    input_ref_id: Mapped[str] = mapped_column(Uuid(as_uuid=False))
    input_kind: Mapped[str] = mapped_column(String)
    state: Mapped[str] = mapped_column(String, index=True)
    attempt: Mapped[int] = mapped_column(Integer, default=0)
    lease_token: Mapped[str | None] = mapped_column(String)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    request_payload: Mapped[dict | None] = mapped_column(JSONB)
    payload: Mapped[dict] = mapped_column(JSONB)


class Outbox(Base):
    __tablename__ = "outbox"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id"), unique=True)
    queue: Mapped[str] = mapped_column(String)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class JobEvent(Base):
    __tablename__ = "job_events"
    sequence: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id"), index=True)
    payload: Mapped[dict] = mapped_column(JSONB)


class ResearchReceipt(Base):
    __tablename__ = "research_receipts"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    actor_id: Mapped[str] = mapped_column(ForeignKey("principals.id"))
    city_id: Mapped[str] = mapped_column(ForeignKey("cities.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    manifest: Mapped[dict] = mapped_column(JSONB)


class ResearchFile(Base):
    __tablename__ = "research_files"
    receipt_id: Mapped[str] = mapped_column(ForeignKey("research_receipts.id"), primary_key=True)
    path: Mapped[str] = mapped_column(String, primary_key=True)
    sha256: Mapped[str] = mapped_column(String(64))
    content: Mapped[bytes] = mapped_column(LargeBinary)


class StagingIdentity(Base):
    __tablename__ = "staging_identities"
    __table_args__ = (UniqueConstraint("namespace", "external_id"),)
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    namespace: Mapped[str] = mapped_column(String)
    external_id: Mapped[str] = mapped_column(String)


class StagingRecord(Base):
    __tablename__ = "staging_records"
    __table_args__ = (UniqueConstraint("identity_id", "sha256"),)
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    identity_id: Mapped[str] = mapped_column(ForeignKey("staging_identities.id"), index=True)
    sha256: Mapped[str] = mapped_column(String(64))
    raw: Mapped[dict] = mapped_column(JSONB)
    interpretation: Mapped[dict] = mapped_column(JSONB)


class StagingOccurrence(Base):
    __tablename__ = "staging_occurrences"
    version_id: Mapped[str] = mapped_column(ForeignKey("dataset_versions.id"), primary_key=True)
    table_name: Mapped[str] = mapped_column(String, primary_key=True)
    row_index: Mapped[int] = mapped_column(Integer, primary_key=True)
    record_id: Mapped[str] = mapped_column(ForeignKey("staging_records.id"))
    source_record_ids: Mapped[list] = mapped_column(JSONB)


class ResearchQuality(Base):
    __tablename__ = "research_quality"
    version_id: Mapped[str] = mapped_column(ForeignKey("dataset_versions.id"), primary_key=True)
    receipt_id: Mapped[str] = mapped_column(ForeignKey("research_receipts.id"))
    request_id: Mapped[str] = mapped_column(String)
    payload: Mapped[dict] = mapped_column(JSONB)
