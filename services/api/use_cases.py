import base64
import hashlib
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import NAMESPACE_URL, uuid4, uuid5

from sqlalchemy import and_, or_, select, text

from packages.domain.contracts import DOMAIN
from packages.domain.errors import DomainError, gap
from packages.geo.geometry import zone_area
from services.api.models import (
    AuditEvent,
    CatalogState,
    City,
    CityGrant,
    CoefficientVersionRecord,
    CohortRecord,
    Dataset,
    DatasetGrant,
    DatasetVersion,
    ImportQuality,
    InspectionRecord,
    Job,
    MapArchiveArtifact,
    MapLayer,
    PlantVersion,
    Principal,
    Program,
    ProgramInputVersion,
    ProgramRevisionRecord,
    RateVersionRecord,
    ResearchQuality,
    RevisionDataset,
    RuleVersionRecord,
    Scenario,
    ScenarioRevision,
    StockItemRecord,
    SurvivalModelRecord,
    Upload,
    WorkCompletionRecord,
    WorkOrderRecord,
    WorkOrderStatusEvent,
    Zone,
    ZoneVersion,
)


def now():
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def uid():
    return str(uuid4())


def canonical_hash(value):
    return hashlib.sha256(
        json.dumps(
            value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode()
    ).hexdigest()


def etag(value):
    return '"' + canonical_hash(value) + '"'


def found(value):
    if value is None:
        raise DomainError(404, "not_found", "Object not found")
    return value


def feature_dimensions(properties, source_ref):
    from packages.domain.heights import record_height

    height, basis, floors = record_height(properties)
    return height, basis, floors, source_ref if height is not None else None


def audit(db, access, action, object_id, object_type, reason=None):
    event = {
        "id": uid(),
        "actor_id": access.user.id,
        "action": action,
        "object_id": object_id,
        "object_type": object_type,
        "occurred_at": now(),
        "reason": reason,
    }
    db.add(AuditEvent(id=event["id"], actor_id=access.user.id, payload=event))


def conditional(request, payload, current):
    if request.headers.get("if-match") != etag(payload):
        raise DomainError(
            412,
            "revision_conflict",
            "The object has changed; reload and compare",
            current_revision_id=current,
        )


def get_zone(db, access, zone_id, lock=False):
    stmt = select(Zone).where(Zone.id == zone_id)
    zone = found(db.scalar(stmt.with_for_update() if lock else stmt))
    access.city(zone.city_id)
    return zone, found(db.get(ZoneVersion, zone.current_version_id))


def get_zone_version(db, access, version_id):
    version = found(db.get(ZoneVersion, version_id))
    zone = found(db.get(Zone, version.zone_id))
    access.city(zone.city_id)
    return version


def readiness_item(version):
    keys = DOMAIN["$defs"]["SourceReadiness"]["required"]
    return {
        "dataset_id": version.dataset_id,
        "dataset_version_id": version.id,
        **{
            key: version.payload[key]
            for key in keys
            if key not in {"dataset_id", "dataset_version_id"}
        },
    }


def revision_access(db, access, revision):
    for version_id in db.scalars(
        select(RevisionDataset.version_id).where(RevisionDataset.revision_id == revision.id)
    ):
        version = found(db.get(DatasetVersion, version_id))
        access.dataset(found(db.get(Dataset, version.dataset_id)))
    if revision.payload.get("rule_version_id"):
        from services.api.catalog import authorized_rule

        authorized_rule(db, access, revision.payload["rule_version_id"])
    rate_ids = revision.payload.get("rate_version_ids", [])
    if not rate_ids and revision.payload.get("rate_version_id"):
        rate_ids = [revision.payload["rate_version_id"]]
    for rate_id in rate_ids:
        from services.api.calculations import authorize_rate

        authorize_rate(db, access, rate_id)
    if revision.payload.get("model_version_id"):
        from services.api.catalog import authorized_model

        authorized_model(db, access, revision.payload["model_version_id"])
    if revision.payload.get("coefficient_version_id"):
        from services.api.coefficients import authorize_coefficient

        authorize_coefficient(db, access, revision.payload["coefficient_version_id"])


def scenario_access(db, access, scenario):
    access.city(scenario.city_id)
    if scenario.status != "approved" and scenario.owner_id != access.user.id and access.level < 2:
        raise DomainError(404, "not_found", "Object not found")
    revision = found(db.get(ScenarioRevision, scenario.current_revision_id))
    revision_access(db, access, revision)
    return revision


def get_scenario(db, access, scenario_id, lock=False):
    stmt = select(Scenario).where(Scenario.id == scenario_id)
    scenario = found(db.scalar(stmt.with_for_update() if lock else stmt))
    scenario_access(db, access, scenario)
    return scenario


def authorized_revision(db, access, revision_id):
    revision = found(db.get(ScenarioRevision, revision_id))
    get_scenario(db, access, revision.scenario_id)
    revision_access(db, access, revision)
    return revision


def page(
    db,
    model,
    statement,
    params,
    operation,
    access,
    authorize=None,
    serialize=None,
    key_attribute="id",
):
    """Bounded DB keyset pages; authorization occurs before adding each response item."""
    from uuid import UUID

    limit = int(params.get("limit", 50))
    context = canonical_hash(
        {
            "operation": operation,
            "user": access.user.id,
            "filters": {k: v for k, v in params.items() if k != "cursor"},
        }
    )
    after = None
    if params.get("cursor"):
        try:
            cursor = json.loads(base64.urlsafe_b64decode(params["cursor"].encode()))
            if cursor["context"] != context:
                raise ValueError()
            after = str(UUID(cursor["after"]))
        except (ValueError, KeyError, TypeError):
            raise DomainError(422, "invalid_cursor", "Cursor does not match this query") from None
    values, keys = [], []
    while len(values) <= limit:
        key_column = getattr(model, key_attribute)
        batch_query = statement.order_by(key_column).limit(limit + 1)
        if after:
            batch_query = batch_query.where(key_column > after)
        rows = list(db.scalars(batch_query))
        if not rows:
            break
        for row in rows:
            after = getattr(row, key_attribute)
            try:
                if authorize:
                    authorize(row)
                values.append(serialize(row) if serialize else row.payload)
                keys.append(getattr(row, key_attribute))
            except DomainError as error:
                if error.status not in {403, 404}:
                    raise
            if len(values) > limit:
                break
        if len(rows) < limit + 1:
            break
    next_cursor = None
    if len(values) > limit:
        next_cursor = base64.urlsafe_b64encode(
            json.dumps({"after": keys[limit - 1], "context": context}).encode()
        ).decode()
    return {"items": values[:limit], "next_cursor": next_cursor}


MAP_CATEGORY = {
    "boundary": "boundary",
    "zones": "zone",
    "soil": "soil",
    "green_inventory": "existing_green",
    "buildings": "building",
    "roads": "road",
    "water": "water",
    "population": "population",
    "social_poi": "social_facility",
    "restrictions": "restriction",
    "observations": "data_quality",
}


def map_layer_payload(db, layer):
    """Promote only registered public immutable archives; protected layers stay dynamic MVT."""
    dataset = found(db.get(Dataset, layer.dataset_id))
    if dataset.access_level != "public":
        return layer.payload
    artifact = db.scalar(
        select(MapArchiveArtifact).where(MapArchiveArtifact.map_layer_id == layer.id)
    )
    if not artifact or artifact.dataset_version_id != layer.dataset_version_id:
        return layer.payload
    return {
        **layer.payload,
        "source_type": "pmtiles",
        "source_url": f"/v1/map/archives/{layer.id}.pmtiles",
        "min_zoom": artifact.min_zoom,
        "max_zoom": artifact.max_zoom,
    }
GEOMETRY_LABEL = {"point": "точки", "line": "линии", "polygon": "полигоны"}


def publish_map_layers(db, dataset, version):
    """Create immutable manifests only for reviewed vector geometry in the published version."""
    if version.payload["content_kind"] != "vector":
        return
    families = list(
        db.scalars(
            text(
                """
                SELECT DISTINCT CASE
                  WHEN GeometryType(geometry) IN ('POINT','MULTIPOINT') THEN 'point'
                  WHEN GeometryType(geometry) IN ('LINESTRING','MULTILINESTRING') THEN 'line'
                  WHEN GeometryType(geometry) IN ('POLYGON','MULTIPOLYGON') THEN 'polygon'
                END
                FROM import_records
                WHERE version_id=:version_id AND geometry IS NOT NULL
                """
            ),
            {"version_id": version.id},
        )
    )
    families = sorted(family for family in families if family)
    category = MAP_CATEGORY.get(dataset.payload["kind"], "data_quality")
    for family in families:
        layer_id = str(uuid5(NAMESPACE_URL, f"pavlodar:map-layer:{version.id}:{family}"))
        name = dataset.payload["name"]
        if len(families) > 1:
            name = f"{name} — {GEOMETRY_LABEL[family]}"
        period = None
        if version.payload["observed_from"] or version.payload["observed_to"]:
            period = {
                "from": version.payload["observed_from"],
                "to": version.payload["observed_to"],
            }
        payload = {
            "id": layer_id,
            "city_id": dataset.city_id,
            "dataset_id": dataset.id,
            "name": name,
            "kind": dataset.payload["kind"],
            "source_type": "mvt",
            "source_url": f"/v1/map/tiles/{layer_id}/{{z}}/{{x}}/{{y}}.mvt",
            "dataset_version_id": version.id,
            "min_zoom": 5,
            "max_zoom": 22,
            "attribution": f"{dataset.payload['owner']} · {dataset.payload['license']}",
            "access_level": dataset.access_level,
            "observed_at": version.payload["observed_at"],
            "category": category,
            "source_layer": "features",
            "geometry_type": family,
            "is_stale": False,
            "legend": {
                "mode": "single",
                "property": None,
                "unit": None,
                "period": period,
                "classes": [
                    {
                        "key": "feature",
                        "label": "Объекты опубликованного набора",
                        "min": None,
                        "max": None,
                        "value": None,
                        "semantic": "neutral",
                    }
                ],
                "unknown_class_key": None,
            },
        }
        db.add(
            MapLayer(
                id=layer_id,
                city_id=dataset.city_id,
                dataset_id=dataset.id,
                dataset_version_id=version.id,
                geometry_type=family,
                payload=payload,
            )
        )


def audit_access(db, access, event):
    payload = event.payload
    identity, kind = payload["object_id"], payload["object_type"]
    if kind == "ZoneVersion":
        version = found(db.get(ZoneVersion, identity))
        get_zone(db, access, version.zone_id)
    elif kind == "ScenarioRevision":
        authorized_revision(db, access, identity)
    elif kind == "Dataset":
        dataset = found(db.get(Dataset, identity))
        if payload["action"].startswith("dataset.grant_"):
            access.city(dataset.city_id)
        else:
            access.dataset(dataset)
    elif kind == "DatasetVersion":
        version = found(db.get(DatasetVersion, identity))
        access.dataset(found(db.get(Dataset, version.dataset_id)))
    elif kind == "Plant":
        from services.api.catalog import current_plant

        found(current_plant(db, identity))
    elif kind == "RuleVersion":
        from services.api.catalog import authorized_rule

        authorized_rule(db, access, identity)
    elif kind == "RateVersion":
        from services.api.calculations import authorize_rate

        authorize_rate(db, access, identity)
    elif kind == "CoefficientVersion":
        from services.api.coefficients import authorize_coefficient

        authorize_coefficient(db, access, identity)
    elif kind == "DetectedProblem":
        from services.api.models import ProblemDecisionRecord

        decision = found(db.get(ProblemDecisionRecord, identity))
        zone = found(db.get(Zone, decision.zone_id))
        access.city(zone.city_id)
    elif kind == "CalculationSnapshot":
        from services.api.calculations import authorized_snapshot

        authorized_snapshot(db, access, identity)
    elif kind == "Upload":
        upload = found(db.get(Upload, identity))
        access.dataset(found(db.get(Dataset, upload.dataset_id)))
    elif kind == "Job":
        job = found(db.get(Job, identity))
        from services.worker.jobs import authorize_job_input

        authorize_job_input(db, access, job)
    elif kind == "WorkOrder":
        from services.api.work_orders import get_work_order

        get_work_order(db, access, identity)
    elif kind == "WorkCompletion":
        from services.api.work_orders import get_work_order

        completion = found(db.get(WorkCompletionRecord, identity))
        get_work_order(db, access, completion.work_order_id)
    elif kind == "Cohort":
        from services.api.cohorts import get_cohort

        get_cohort(db, access, identity)
    elif kind == "Inspection":
        from services.api.cohorts import inspection_access

        inspection_access(db, access, found(db.get(InspectionRecord, identity)))
    else:
        raise DomainError(404, "not_found", "Object not found")


def save_revision(db, access, scenario, body):
    zone_version = found(db.get(ZoneVersion, body["zone_version_id"]))
    if zone_version.zone_id != scenario.zone_id:
        raise DomainError(422, "zone_version_mismatch", "Zone version belongs to another zone")
    versions = []
    for version_id in body["dataset_version_ids"]:
        version = found(db.get(DatasetVersion, version_id))
        dataset = found(db.get(Dataset, version.dataset_id))
        access.dataset(dataset)
        if dataset.city_id != scenario.city_id or version.status != "published":
            raise DomainError(
                422, "dataset_version_unavailable", "Select published inputs in this city"
            )
        versions.append(version)
    if len(set(body["dataset_version_ids"])) != len(versions):
        raise DomainError(422, "duplicate_version", "Duplicate dataset version")
    coefficient_synthetic = False
    if body["coefficient_version_id"] is not None:
        from services.api.coefficients import authorize_coefficient

        coefficient = authorize_coefficient(
            db,
            access,
            body["coefficient_version_id"],
            city_id=scenario.city_id,
            usable=True,
        )
        if coefficient.dataset_version_id not in body["dataset_version_ids"]:
            raise DomainError(
                422,
                "coefficient_version_unavailable",
                "Coefficient dataset version must be frozen in the scenario revision",
            )
        coefficient_synthetic = db.get(
            DatasetVersion, coefficient.dataset_version_id
        ).synthetic
    rule_synthetic = False
    if body["rule_version_id"]:
        from services.api.catalog import authorized_rule

        rule = authorized_rule(db, access, body["rule_version_id"], city_id=scenario.city_id)
        rule_synthetic = db.get(DatasetVersion, rule.dataset_version_id).synthetic
    from services.api.catalog import validate_scenario_registry

    catalog_synthetic = validate_scenario_registry(
        db, access, scenario, zone_version, body
    )
    model_synthetic = False
    if body["model_version_id"]:
        from services.api.catalog import authorized_model

        model = authorized_model(
            db,
            access,
            body["model_version_id"],
            city_id=scenario.city_id,
            usable=True,
        )
        if model.dataset_version_id not in body["dataset_version_ids"]:
            raise DomainError(
                422,
                "model_version_unavailable",
                "Model dataset version must be frozen in the scenario revision",
            )
        model_synthetic = db.get(DatasetVersion, model.dataset_version_id).synthetic
    from services.api.calculations import validate_revision_rates

    rate_ids = list(body.get("rate_version_ids", []))
    if body["rate_version_id"] and body["rate_version_id"] not in rate_ids:
        rate_ids.append(body["rate_version_id"])
    rate_synthetic = validate_revision_rates(db, access, scenario, rate_ids)
    from services.api.calculations import validate_care_calendar

    validate_care_calendar(db, access, scenario, body, rate_ids)
    normalized_body = {**body, "rate_version_ids": rate_ids}
    revision_id = uid()
    payload = {
        "id": revision_id,
        "scenario_id": scenario.id,
        **normalized_body,
        "created_at": now(),
        "input_hash": canonical_hash(normalized_body),
        "synthetic_inputs": zone_version.synthetic
        or any(v.synthetic for v in versions)
        or catalog_synthetic
        or rate_synthetic
        or coefficient_synthetic
        or rule_synthetic
        or model_synthetic,
    }
    revision = ScenarioRevision(
        id=revision_id,
        scenario_id=scenario.id,
        zone_version_id=body["zone_version_id"],
        parent_revision_id=body["parent_revision_id"],
        payload=payload,
    )
    db.add(revision)
    db.flush()
    for version in versions:
        db.add(RevisionDataset(revision_id=revision_id, version_id=version.id))
    scenario.current_revision_id = revision_id
    scenario.payload = {**scenario.payload, "current_revision_id": revision_id, "updated_at": now()}
    audit(db, access, "scenario.revision_created", revision_id, "ScenarioRevision")
    return payload


def execute(operation, db, access, params, body, request):
    headers = {}
    if operation == "getCurrentUser":
        return {
            "id": access.user.id,
            "display_name": access.user.display_name,
            "roles": access.user.roles,
            "city_ids": sorted(access.cities),
            "csrf_token": access.session.csrf_token,
        }, headers
    if operation == "listCities":
        result = page(
            db, City, select(City).where(City.id.in_(access.cities)), params, operation, access
        )
    elif operation == "getCity":
        access.city(params["city_id"])
        result = found(db.get(City, params["city_id"])).payload
    elif operation == "createDataset":
        access.city(body["city_id"])
        dataset_id = uid()
        result = {"id": dataset_id, **body, "current_version_id": None, "created_at": now()}
        db.add(
            Dataset(
                id=dataset_id,
                city_id=body["city_id"],
                owner_id=access.user.id,
                access_level=body["access_level"],
                payload=result,
            )
        )
        db.flush()
        db.add(DatasetGrant(user_id=access.user.id, dataset_id=dataset_id))
        audit(db, access, "dataset.created", dataset_id, "Dataset")
    elif operation == "createUploadTicket":
        dataset = found(db.get(Dataset, params["dataset_id"]))
        access.dataset(dataset)
        access.role("specialist")
        allowed_types = {
            "application/geo+json",
            "text/csv",
            "application/vnd.google-earth.kml+xml",
            "application/zip",
        }
        filename = body["filename"]
        if (
            Path(filename).name != filename
            or len(filename) > 255
            or any(ord(char) < 32 for char in filename)
        ):
            raise DomainError(422, "upload_filename_invalid", "Filename must be a plain name")
        if body["content_type"].lower() not in allowed_types:
            raise DomainError(415, "upload_content_type_rejected", "Upload type is not allowed")
        upload_id = uid()
        created = datetime.now(UTC)
        expires = created + timedelta(minutes=15)
        db.add(
            Upload(
                id=upload_id,
                dataset_id=dataset.id,
                owner_id=access.user.id,
                filename=filename,
                content_type=body["content_type"].lower(),
                byte_size=body["byte_size"],
                sha256=body["sha256"],
                state="ticketed",
                storage_key=uid(),
                created_at=created,
                expires_at=expires,
            )
        )
        result = {
            "upload_id": upload_id,
            "put_url": f"/v1/uploads/{upload_id}",
            "expires_at": expires.isoformat().replace("+00:00", "Z"),
            "required_content_type": body["content_type"].lower(),
        }
        audit(db, access, "upload.ticket_created", upload_id, "Upload")
    elif operation == "startImport":
        dataset = found(db.get(Dataset, params["dataset_id"]))
        access.dataset(dataset)
        upload = found(
            db.scalar(select(Upload).where(Upload.id == body["upload_id"]).with_for_update())
        )
        if upload.dataset_id != dataset.id or (
            upload.owner_id != access.user.id and access.level < 2
        ):
            raise DomainError(404, "not_found", "Object not found")
        if upload.state != "stored" or upload.import_job_id:
            raise DomainError(409, "upload_not_ready", "Upload is not ready for import")
        expected_types = {
            "geojson": "application/geo+json",
            "csv": "text/csv",
            "kml": "application/vnd.google-earth.kml+xml",
            "shp_zip": "application/zip",
        }
        if expected_types[body["format"]] != upload.content_type:
            raise DomainError(422, "upload_format_mismatch", "Import format does not match upload")
        from services.worker.jobs import enqueue_import

        job = enqueue_import(db, access, dataset, upload, body)
        upload.state = "consumed"
        upload.import_job_id = job.id
        upload.import_request = body
        audit(db, access, "import.queued", job.id, "Job")
        result = job.payload
    elif operation == "listDatasets":
        access.city(params["city_id"])
        result = page(
            db,
            Dataset,
            select(Dataset).where(Dataset.city_id == params["city_id"]),
            params,
            operation,
            access,
            authorize=access.dataset,
        )
    elif operation == "listDatasetVersions":
        dataset = found(db.get(Dataset, params["dataset_id"]))
        access.dataset(dataset)
        stmt = select(DatasetVersion).where(DatasetVersion.dataset_id == dataset.id)
        if access.level == 0:
            stmt = stmt.where(DatasetVersion.status == "published")
        result = page(db, DatasetVersion, stmt, params, operation, access)
    elif operation == "listSourceReadiness":
        access.city(params["city_id"])
        stmt = (
            select(DatasetVersion)
            .join(Dataset, DatasetVersion.dataset_id == Dataset.id)
            .where(Dataset.city_id == params["city_id"])
        )
        if params.get("dataset_id"):
            stmt = stmt.where(DatasetVersion.dataset_id == params["dataset_id"])
        result = page(
            db,
            DatasetVersion,
            stmt,
            params,
            operation,
            access,
            authorize=lambda version: access.dataset(found(db.get(Dataset, version.dataset_id))),
            serialize=readiness_item,
        )
    elif operation == "listMapLayers":
        access.city(params["city_id"])
        result = page(
            db,
            MapLayer,
            select(MapLayer)
            .join(Dataset, MapLayer.dataset_id == Dataset.id)
            .where(
                MapLayer.city_id == params["city_id"],
                Dataset.current_version_id == MapLayer.dataset_version_id,
            ),
            params,
            operation,
            access,
            authorize=lambda layer: access.dataset(found(db.get(Dataset, layer.dataset_id))),
            serialize=lambda layer: map_layer_payload(db, layer),
        )
    elif operation == "listCityPrincipals":
        access.city(params["city_id"])
        result = page(
            db,
            Principal,
            select(Principal)
            .join(CityGrant, CityGrant.user_id == Principal.id)
            .where(CityGrant.city_id == params["city_id"], Principal.active.is_(True)),
            params,
            operation,
            access,
            serialize=lambda principal: {
                "id": principal.id,
                "display_name": principal.display_name,
                "roles": principal.roles,
                "active": principal.active,
            },
        )
    elif operation == "listDatasetGrants":
        dataset = found(db.get(Dataset, params["dataset_id"]))
        access.city(dataset.city_id)
        if dataset.access_level != "restricted":
            raise DomainError(422, "grant_not_applicable", "Dataset is not restricted")
        result = page(
            db,
            DatasetGrant,
            select(DatasetGrant).where(DatasetGrant.dataset_id == dataset.id),
            params,
            operation,
            access,
            serialize=lambda grant: {
                "dataset_id": grant.dataset_id,
                "user_id": grant.user_id,
            },
            key_attribute="user_id",
        )
    elif operation == "grantDatasetAccess":
        dataset = found(db.get(Dataset, params["dataset_id"]))
        access.city(dataset.city_id)
        if dataset.access_level != "restricted":
            raise DomainError(422, "grant_not_applicable", "Dataset is not restricted")
        principal = found(db.get(Principal, body["user_id"]))
        if not principal.active or not db.get(CityGrant, (principal.id, dataset.city_id)):
            raise DomainError(
                422,
                "grant_city_mismatch",
                "Grant recipient must be an active user of the dataset city",
            )
        if db.get(DatasetGrant, (principal.id, dataset.id)):
            raise DomainError(409, "grant_exists", "Dataset grant already exists")
        result = {"dataset_id": dataset.id, "user_id": principal.id}
        db.add(DatasetGrant(user_id=principal.id, dataset_id=dataset.id))
        audit(db, access, "dataset.grant_added", dataset.id, "Dataset", body["reason"])
    elif operation == "revokeDatasetAccess":
        dataset = found(db.get(Dataset, params["dataset_id"]))
        access.city(dataset.city_id)
        if dataset.access_level != "restricted":
            raise DomainError(422, "grant_not_applicable", "Dataset is not restricted")
        grant = found(db.get(DatasetGrant, (params["user_id"], dataset.id)))
        result = {"dataset_id": dataset.id, "user_id": grant.user_id}
        db.delete(grant)
        audit(db, access, "dataset.grant_revoked", dataset.id, "Dataset", body["reason"])
    elif operation == "getMapFeature":
        row = found(
            db.execute(
                text(
                    """
                    SELECT ir.version_id, ir.row_index, ir.payload,
                      ST_AsGeoJSON(ir.geometry)::jsonb AS geometry,
                      dv.dataset_id
                    FROM import_records ir
                    JOIN dataset_versions dv ON dv.id=ir.version_id
                    JOIN datasets d ON d.id=dv.dataset_id
                    WHERE ((md5('pavlodar:map-feature:' || ir.version_id::text || ':' || ir.row_index::text))::uuid)=CAST(:feature_id AS uuid)
                      AND d.current_version_id=ir.version_id
                      AND dv.status='published'
                      AND ir.geometry IS NOT NULL
                    """
                ),
                {"feature_id": params["feature_id"]},
            )
            .mappings()
            .one_or_none()
        )
        dataset = found(db.get(Dataset, row["dataset_id"]))
        access.dataset(dataset)
        properties = row["payload"].get("properties", {})
        source_record_id = row["payload"].get("source_record_id")
        label = next(
            (
                str(properties[key]).strip()
                for key in ("label", "name", "title")
                if properties.get(key) is not None and str(properties[key]).strip()
            ),
            source_record_id or f"Объект {row['row_index'] + 1}",
        )
        source_ref = {
            "dataset_version_id": str(row["version_id"]),
            "source_record_id": source_record_id,
            "label": dataset.payload["name"],
            "uri": dataset.payload["source_uri"],
        }
        height, height_basis, floors, height_source_ref = feature_dimensions(
            properties, source_ref
        )
        result = {
            "id": params["feature_id"],
            "dataset_version_id": str(row["version_id"]),
            "geometry": row["geometry"],
            "label": label,
            "metrics": [],
            "source_refs": [source_ref],
            "height_m": height,
            "height_basis": height_basis,
            "floors": floors,
            "height_source_ref": height_source_ref,
        }
    elif operation in {"getQualityReport", "publishDatasetVersion", "rejectDatasetVersion"}:
        version = found(db.get(DatasetVersion, params["version_id"]))
        dataset = found(db.get(Dataset, version.dataset_id))
        access.dataset(dataset)
        research_report = db.get(ResearchQuality, version.id)
        import_report = db.get(ImportQuality, version.id)
        report = found(research_report or import_report)
        if operation == "publishDatasetVersion":
            if research_report:
                from services.api.research import publication_blockers

                raise DomainError(
                    422,
                    "research_publication_blocked",
                    "Research staging requires expert and owner acceptance",
                    blockers=publication_blockers(),
                )
            if version.status != "needs_review" or not report.payload["publish_allowed"]:
                raise DomainError(
                    422,
                    "dataset_publication_blocked",
                    "Version has errors or unresolved provenance",
                    blockers=version.payload["review_reasons"],
                )
            published_at = now()
            version.status = "published"
            version.payload = {
                **version.payload,
                "status": "published",
                "published_at": published_at,
                "review_reasons": [],
            }
            dataset.current_version_id = version.id
            dataset.payload = {**dataset.payload, "current_version_id": version.id}
            publish_map_layers(db, dataset, version)
            db.flush()
            db.scalar(
                text("SELECT index_address_version(:version_id)"),
                {"version_id": version.id},
            )
            from services.api.catalog import (
                promote_rule_versions,
                promote_stock_items,
                promote_survival_models,
            )

            promote_rule_versions(db, dataset, version)
            promote_stock_items(db, dataset, version)
            promote_survival_models(db, dataset, version)
            audit(
                db,
                access,
                "dataset_version.published",
                version.id,
                "DatasetVersion",
                body["reason"],
            )
            result = version.payload
        elif operation == "rejectDatasetVersion":
            if version.status not in {"needs_review", "validating", "quarantine"}:
                raise DomainError(409, "invalid_transition", "Version cannot be rejected")
            version.status = "rejected"
            version.payload = {
                **version.payload,
                "status": "rejected",
                "review_reasons": [
                    *version.payload["review_reasons"],
                    gap("version_rejected", "Версия отклонена администратором"),
                ],
            }
            audit(
                db,
                access,
                "dataset_version.rejected",
                version.id,
                "DatasetVersion",
                body["reason"],
            )
            result = version.payload
        else:
            from services.api.research import quality_page

            result = quality_page(report.payload, params, access.user.id)
    elif operation == "listPlants":
        state = found(db.get(CatalogState, "global"))
        if state.current_version_id is None:
            result = {"items": [], "next_cursor": None}
        else:
            statement = select(PlantVersion).where(
                PlantVersion.catalog_version_id == state.current_version_id
            )
            if params.get("stratum"):
                statement = statement.where(
                    PlantVersion.payload["stratum"].astext == params["stratum"]
                )
            if params.get("q"):
                statement = statement.where(
                    text(
                        "(position(lower(:plant_q) in lower(plant_versions.payload->>'latin_name'))>0 "
                        "OR position(lower(:plant_q) in lower(plant_versions.payload->>'russian_name'))>0)"
                    )
                ).params(plant_q=params["q"])
            result = page(
                db,
                PlantVersion,
                statement,
                params,
                operation,
                access,
                key_attribute="plant_id",
            )
    elif operation == "getPlant":
        from services.api.catalog import current_plant

        plant = found(current_plant(db, params["plant_id"]))
        result = plant.payload
        headers["ETag"] = etag(result)
    elif operation in {"createPlant", "createPlantVersion"}:
        from services.api.catalog import create_snapshot, current_plant

        plant_id = params.get("plant_id")
        if plant_id:
            current = found(current_plant(db, plant_id))
            conditional(request, current.payload, current.catalog_version_id)
        result = create_snapshot(db, access, body, plant_id=plant_id)
        audit(
            db,
            access,
            "plant.version_created" if plant_id else "plant.created",
            result["id"],
            "Plant",
        )
        headers["ETag"] = etag(result)
    elif operation == "listRuleVersions":
        from services.api.catalog import authorized_rule

        access.city(params["city_id"])
        statement = select(RuleVersionRecord).join(
            Dataset, Dataset.id == RuleVersionRecord.dataset_id
        ).join(
            DatasetVersion, DatasetVersion.id == RuleVersionRecord.dataset_version_id
        ).where(Dataset.city_id == params["city_id"])
        if params.get("usable", False):
            statement = statement.where(
                or_(
                    RuleVersionRecord.payload["review_status"].astext == "expert_confirmed",
                    and_(
                        DatasetVersion.synthetic.is_(True),
                        RuleVersionRecord.payload["review_status"].astext
                        == "verified_text_requires_expert",
                    ),
                ),
                RuleVersionRecord.payload["superseded_by"].astext.is_(None),
            )
        result = page(
            db,
            RuleVersionRecord,
            statement,
            params,
            operation,
            access,
            authorize=lambda row: authorized_rule(db, access, row.id),
        )
    elif operation == "getRuleVersion":
        from services.api.catalog import authorized_rule

        rule = authorized_rule(db, access, params["rule_version_id"])
        result = rule.payload
    elif operation == "listStock":
        from services.api.catalog import authorized_stock

        statement = select(StockItemRecord)
        if params.get("plant_id"):
            statement = statement.where(StockItemRecord.plant_id == params["plant_id"])
        result = page(
            db,
            StockItemRecord,
            statement,
            params,
            operation,
            access,
            authorize=lambda row: authorized_stock(db, access, row.id),
        )
    elif operation in {"listModelVersions", "getModelVersion"}:
        from services.api.catalog import authorized_model

        if operation == "getModelVersion":
            result = authorized_model(db, access, params["model_version_id"]).payload
        else:
            access.city(params["city_id"])
            statement = select(SurvivalModelRecord).where(
                SurvivalModelRecord.city_id == params["city_id"]
            )
            if params.get("usable", False):
                statement = statement.join(
                    DatasetVersion,
                    DatasetVersion.id == SurvivalModelRecord.dataset_version_id,
                ).where(
                    or_(
                        and_(
                            SurvivalModelRecord.payload["expert_status"].astext == "approved",
                            SurvivalModelRecord.payload["calibration_status"].astext
                            != "uncalibrated",
                        ),
                        and_(
                            DatasetVersion.synthetic.is_(True),
                            SurvivalModelRecord.payload["expert_status"].astext == "pending",
                            SurvivalModelRecord.payload["calibration_status"].astext
                            == "uncalibrated",
                        ),
                    )
                )
            result = page(
                db,
                SurvivalModelRecord,
                statement,
                params,
                operation,
                access,
                authorize=lambda row: authorized_model(db, access, row.id),
            )
    elif operation == "recommendPlants":
        from services.api.catalog import recommend

        zone_version = get_zone_version(db, access, body["zone_version_id"])
        result = recommend(db, access, body, zone_version)
    elif operation == "listRates":
        from services.api.calculations import authorize_rate

        access.city(params["city_id"])
        result = page(
            db,
            RateVersionRecord,
            select(RateVersionRecord).where(RateVersionRecord.city_id == params["city_id"]),
            params,
            operation,
            access,
            authorize=lambda row: authorize_rate(db, access, row.id),
        )
    elif operation == "createRateVersion":
        from services.api.calculations import create_rate_version

        result = create_rate_version(db, access, body, uid=uid)
        audit(db, access, "rate.version_created", result["version_id"], "RateVersion")
    elif operation == "listCoefficients":
        from services.api.coefficients import authorize_coefficient

        result = page(
            db,
            CoefficientVersionRecord,
            select(CoefficientVersionRecord),
            params,
            operation,
            access,
            authorize=lambda row: authorize_coefficient(db, access, row.id),
        )
    elif operation == "createCoefficientVersion":
        from services.api.coefficients import create_coefficient_version

        result = create_coefficient_version(db, access, body, uid=uid)
        audit(
            db,
            access,
            "coefficient.version_created",
            result["version_id"],
            "CoefficientVersion",
        )
    elif operation == "calculateFast":
        from services.api.calculations import calculate_fast

        result = calculate_fast(
            db,
            access,
            body,
            uid=uid,
            canonical_hash=canonical_hash,
            now=now,
        )
    elif operation == "compareScenarios":
        from services.api.calculations import compare_scenarios

        result = compare_scenarios(db, access, body)
    elif operation == "startCalculation":
        if body["mode"] != "full":
            raise DomainError(422, "calculation_request_invalid", "Use calculateFast for fast mode")
        revision = authorized_revision(db, access, body["scenario_revision_id"])
        from services.worker.jobs import enqueue

        job = enqueue(db, access, revision, "calculate", request_payload=body)
        audit(db, access, "calculation.queued", job.id, "Job")
        result = job.payload
    elif operation == "startShadowRun":
        from services.worker.jobs import enqueue
        from services.worker.shadow import parse_request

        parse_request(body)
        revision = authorized_revision(db, access, body["scenario_revision_id"])
        job = enqueue(db, access, revision, "shadow", request_payload=body)
        audit(db, access, "shadow.queued", job.id, "Job")
        result = job.payload
    elif operation == "startThermalRun":
        from services.api.thermal import validate_thermal_request
        from services.worker.jobs import enqueue

        revision = authorized_revision(db, access, body["scenario_revision_id"])
        validate_thermal_request(db, access, revision, body)
        job = enqueue(db, access, revision, "thermal", request_payload=body)
        audit(db, access, "thermal.queued", job.id, "Job")
        result = job.payload
    elif operation == "getSpatialResult":
        from services.worker.shadow import get_spatial_result

        result = get_spatial_result(db, access, params["result_id"])
    elif operation == "getSpatialResultArtifact":
        from services.worker.shadow import get_spatial_artifact

        result = get_spatial_artifact(db, access, params["result_id"])
    elif operation == "listCalculations":
        from services.api.calculations import list_snapshots

        result = list_snapshots(db, access, params, operation)
    elif operation in {"getCalculation", "getCalculationManifest"}:
        from services.api.calculations import authorized_snapshot, snapshot_payload

        if operation == "getCalculation":
            result = snapshot_payload(db, access, params["calculation_id"])
        else:
            result = authorized_snapshot(db, access, params["calculation_id"]).manifest
    elif operation in {"createZone", "updateZone"}:
        access.city(body["city_id"])
        city = found(db.get(City, body["city_id"]))
        if operation == "updateZone":
            zone, old = get_zone(db, access, params["zone_id"], lock=True)
            conditional(request, old.payload, old.id)
            if body["city_id"] != zone.city_id:
                raise DomainError(422, "city_mismatch", "A zone cannot change cities")
        else:
            zone = Zone(id=uid(), city_id=body["city_id"], current_version_id=uid())
            db.add(zone)
            db.flush()
        version_id = uid()
        result = {
            "id": zone.id,
            "version_id": version_id,
            **body,
            "area_m2": zone_area(body["geometry"], city.payload["boundary"]),
            "data_gaps": [
                gap(
                    "safety_inputs_missing",
                    "Soil, utilities and expert restrictions have not been verified",
                    "DR-03",
                )
            ],
            "updated_at": now(),
        }
        db.add(
            ZoneVersion(id=version_id, zone_id=zone.id, payload=result, synthetic=city.synthetic)
        )
        zone.current_version_id = version_id
        audit(db, access, "zone.version_created", version_id, "ZoneVersion")
        headers["ETag"] = etag(result)
    elif operation == "getZone":
        _, version = get_zone(db, access, params["zone_id"])
        result = version.payload
        headers["ETag"] = etag(result)
    elif operation == "getZoneVersion":
        result = get_zone_version(db, access, params["version_id"]).payload
    elif operation == "getZoneContext":
        zone, version = get_zone(db, access, params["zone_id"])
        from services.api.zone_context import build_zone_context

        result = build_zone_context(db, access, zone, version)
    elif operation == "listProblems":
        from services.api.problems import list_problems

        result = list_problems(db, access, params)
    elif operation == "dismissProblem":
        from services.api.problems import dismiss_problem

        accessible_city_ids = []
        for city_id in db.scalars(select(City.id).order_by(City.id)):
            try:
                access.city(city_id)
                accessible_city_ids.append(city_id)
            except DomainError as error:
                if error.status not in {403, 404}:
                    raise
        result = dismiss_problem(
            db,
            access,
            params["problem_id"],
            body["reason"],
            city_ids=accessible_city_ids,
        )
        audit(db, access, "problem.dismissed", params["problem_id"], "DetectedProblem")
    elif operation == "listZones":
        access.city(params["city_id"])
        stmt = (
            select(ZoneVersion)
            .join(Zone, Zone.current_version_id == ZoneVersion.id)
            .where(Zone.city_id == params["city_id"])
        )
        if params.get("purpose"):
            stmt = stmt.where(ZoneVersion.payload["purpose"].astext == params["purpose"])
        if "bbox" in params:
            try:
                coords = [float(v) for v in params["bbox"].split(",")]
                if len(coords) != 4 or not (
                    -180 <= coords[0] < coords[2] <= 180 and -90 <= coords[1] < coords[3] <= 90
                ):
                    raise ValueError()
            except ValueError:
                raise DomainError(422, "invalid_bbox", "Expected west,south,east,north") from None
            stmt = stmt.where(
                text(
                    "ST_Intersects(zone_versions.geometry, ST_MakeEnvelope(:west,:south,:east,:north,4326))"
                )
            ).params(**dict(zip(["west", "south", "east", "north"], coords)))
        result = page(db, ZoneVersion, stmt, params, operation, access)
    elif operation == "createProgram":
        from services.api.programs import save_program_input, validate_program_input

        access.city(body["city_id"])
        validate_program_input(db, access, body)
        program_id, input_id, timestamp = uid(), uid(), now()
        payload = {
            "id": program_id,
            **body,
            "status": "draft",
            "current_revision_id": None,
            "updated_at": timestamp,
        }
        program = Program(
            id=program_id,
            city_id=body["city_id"],
            owner_id=access.user.id,
            status="draft",
            current_input_version_id=input_id,
            current_revision_id=None,
            payload=payload,
            updated_at=datetime.fromisoformat(timestamp),
        )
        db.add(program)
        db.flush()
        save_program_input(db, access, program, body, input_id, None, timestamp)
        audit(db, access, "program.input_created", input_id, "ProgramInputVersion")
        result = payload
        headers["ETag"] = etag(payload)
    elif operation == "getProgram":
        from services.api.programs import get_program

        program = get_program(db, access, params["program_id"])
        result = program.payload
        headers["ETag"] = etag(result)
    elif operation == "updateProgramDraft":
        from services.api.programs import (
            get_program,
            save_program_input,
            validate_program_input,
        )

        program = get_program(db, access, params["program_id"], lock=True, mutate=True)
        conditional(request, program.payload, program.current_input_version_id)
        if program.status != "draft":
            raise DomainError(409, "program_not_draft", "Only draft programs accept input changes")
        if body["city_id"] != program.city_id:
            raise DomainError(422, "city_mismatch", "A program cannot change cities")
        validate_program_input(db, access, body)
        previous_id, input_id, timestamp = program.current_input_version_id, uid(), now()
        payload = {
            "id": program.id,
            **body,
            "status": program.status,
            "current_revision_id": program.current_revision_id,
            "updated_at": timestamp,
        }
        save_program_input(db, access, program, body, input_id, previous_id, timestamp)
        program.current_input_version_id = input_id
        program.payload = payload
        program.updated_at = datetime.fromisoformat(timestamp)
        audit(db, access, "program.input_created", input_id, "ProgramInputVersion")
        result = payload
        headers["ETag"] = etag(payload)
    elif operation == "listPrograms":
        from services.api.programs import program_access

        access.city(params["city_id"])
        result = page(
            db,
            Program,
            select(Program).where(Program.city_id == params["city_id"]),
            params,
            operation,
            access,
            authorize=lambda program: program_access(db, access, program),
        )
    elif operation == "optimizeProgram":
        from services.api.programs import get_program, validate_program_input
        from services.worker.jobs import enqueue_program

        if body["program_id"] != params["program_id"]:
            raise DomainError(422, "program_candidates_invalid", "Request targets another program")
        program = get_program(db, access, params["program_id"], lock=True, mutate=True)
        conditional(request, program.payload, program.current_input_version_id)
        if program.status != "draft":
            raise DomainError(409, "program_not_draft", "Only draft programs can be optimized")
        input_version = found(db.get(ProgramInputVersion, program.current_input_version_id))
        validate_program_input(db, access, input_version.payload)
        if not input_version.priority_result_id:
            raise DomainError(
                422,
                "program_priority_invalid",
                "Optimization requires an immutable priority result",
            )
        job = enqueue_program(db, access, program, body)
        audit(db, access, "program.optimization_queued", job.id, "Job")
        result = job.payload
    elif operation == "listProgramRevisions":
        from services.api.programs import get_program, program_revision_access

        program = get_program(db, access, params["program_id"])
        result = page(
            db,
            ProgramRevisionRecord,
            select(ProgramRevisionRecord).where(ProgramRevisionRecord.program_id == program.id),
            params,
            operation,
            access,
            authorize=lambda row: program_revision_access(
                db, access, row, authorized_program=program
            ),
        )
    elif operation == "getProgramRevision":
        from services.api.programs import program_revision_access

        revision = found(db.get(ProgramRevisionRecord, params["revision_id"]))
        program_revision_access(db, access, revision)
        result = revision.payload
    elif operation == "getProgramRevisionDiff":
        from services.api.programs import (
            get_program,
            program_revision_access,
            program_revision_diff,
        )

        program = get_program(db, access, params["program_id"])
        base = found(db.get(ProgramRevisionRecord, params["base_revision_id"]))
        target = found(db.get(ProgramRevisionRecord, params["target_revision_id"]))
        if base.program_id != program.id or target.program_id != program.id:
            raise DomainError(404, "not_found", "Object not found")
        program_revision_access(db, access, base, authorized_program=program)
        program_revision_access(db, access, target, authorized_program=program)
        result = program_revision_diff(base, target)
    elif operation == "transitionProgram":
        from services.api.programs import get_program
        from services.worker.programs import revalidation_blockers

        program = get_program(db, access, params["program_id"], lock=True, mutate=True)
        conditional(
            request,
            program.payload,
            program.current_revision_id or program.current_input_version_id,
        )
        if body["revision_id"] != program.current_revision_id:
            raise DomainError(
                412,
                "revision_conflict",
                "Transition must target the current program revision",
                current_revision_id=program.current_revision_id,
            )
        target = body["target_status"]
        permitted = {
            "draft": {"in_review", "archived"},
            "in_review": {"draft", "approved", "archived"},
            "approved": {"archived"},
            "archived": set(),
        }
        if target not in permitted[program.status]:
            raise DomainError(409, "invalid_transition", "This state transition is not allowed")
        revision = found(db.get(ProgramRevisionRecord, program.current_revision_id))
        blockers = []
        if target in {"in_review", "approved"}:
            if target == "approved":
                access.role("admin")
            blockers = revalidation_blockers(
                db,
                access,
                program,
                revision,
                approval=target == "approved",
            )
        if blockers:
            raise DomainError(
                422,
                "program_transition_blocked",
                "Program transition prerequisites are not satisfied",
                blockers=blockers,
            )
        timestamp = now()
        program.status = target
        program.payload = {**program.payload, "status": target, "updated_at": timestamp}
        program.updated_at = datetime.fromisoformat(timestamp)
        audit(
            db,
            access,
            "program.transition." + target,
            revision.id,
            "ProgramRevision",
            body["reason"],
        )
        result = program.payload
        headers["ETag"] = etag(result)
    elif operation == "listPriorityNormalizations":
        from services.api.priorities import list_normalizations

        result = list_normalizations()
    elif operation == "calculatePriorities":
        from services.api.priorities import calculate_priorities

        result = calculate_priorities(db, access, body, uid(), now())
        audit(db, access, "priority.calculated", result["id"], "PriorityResult")
    elif operation == "getPriorityResult":
        from services.api.priorities import get_priority_result

        result = get_priority_result(db, access, params["priority_id"])
    elif operation == "createScenario":
        zone, _ = get_zone(db, access, body["zone_id"])
        if zone.city_id != body["city_id"]:
            raise DomainError(
                422, "city_mismatch", "Scenario and zone must belong to the same city"
            )
        state = body["initial_state"]
        if body["base_revision_id"]:
            source = authorized_revision(db, access, body["base_revision_id"])
            source_scenario = db.get(Scenario, source.scenario_id)
            if source_scenario.zone_id != zone.id:
                raise DomainError(422, "zone_mismatch", "Copy must refer to the same zone")
            state = {
                k: source.payload[k] for k in DOMAIN["$defs"]["ScenarioRevisionInput"]["properties"]
            }
            state["parent_revision_id"] = None
        scenario_id = uid()
        payload = {
            "id": scenario_id,
            **{k: v for k, v in body.items() if k != "initial_state"},
            "status": "draft",
            "current_revision_id": uid(),
            "updated_at": now(),
        }
        scenario = Scenario(
            id=scenario_id,
            city_id=zone.city_id,
            zone_id=zone.id,
            owner_id=access.user.id,
            status="draft",
            current_revision_id=payload["current_revision_id"],
            payload=payload,
        )
        db.add(scenario)
        db.flush()
        save_revision(db, access, scenario, state)
        result = scenario.payload
        headers["ETag"] = etag(result)
    elif operation == "getScenario":
        result = get_scenario(db, access, params["scenario_id"]).payload
        headers["ETag"] = etag(result)
    elif operation == "transitionScenario":
        scenario = get_scenario(db, access, params["scenario_id"], lock=True)
        conditional(request, scenario.payload, scenario.current_revision_id)
        if body["revision_id"] != scenario.current_revision_id:
            raise DomainError(
                412,
                "revision_conflict",
                "Transition targets an old revision",
                current_revision_id=scenario.current_revision_id,
            )
        target = body["target_status"]
        permitted = {
            "draft": {"in_review", "archived"},
            "in_review": {"draft", "approved", "archived"},
            "approved": {"archived"},
            "archived": set(),
        }
        if target == "approved":
            access.role("admin")
        if target not in permitted[scenario.status]:
            raise DomainError(409, "invalid_transition", "This state transition is not allowed")
        if target == "approved":
            revision = found(db.get(ScenarioRevision, scenario.current_revision_id))
            zone_version = found(db.get(ZoneVersion, revision.zone_version_id))
            blockers = [g for g in zone_version.payload["data_gaps"] if g["blocking"]]
            for key in ["catalog_version_id", "rule_version_id", "model_version_id"]:
                if revision.payload[key] is None:
                    blockers.append(
                        gap("approval_input_missing", "Missing approved input: " + key, key)
                    )
            from services.api.calculations import approval_calculation_blockers, revision_rate_ids

            if not revision_rate_ids(revision):
                blockers.append(
                    gap(
                        "approval_input_missing",
                        "Missing approved input: rate_version_ids",
                        "rate_version_ids",
                    )
                )
            if revision.payload["synthetic_inputs"]:
                blockers.append(
                    gap(
                        "approval_synthetic_inputs",
                        "Synthetic test inputs cannot be internally approved",
                        revision.id,
                    )
                )
            blockers.extend(approval_calculation_blockers(db, revision))
            if blockers:
                raise DomainError(
                    422,
                    "scenario_approval_blocked",
                    "Critical approval prerequisites are missing",
                    blockers=blockers,
                )
        scenario.status = target
        scenario.payload = {**scenario.payload, "status": target, "updated_at": now()}
        audit(
            db,
            access,
            "scenario.transition." + target,
            scenario.current_revision_id,
            "ScenarioRevision",
            body["reason"],
        )
        result = scenario.payload
        headers["ETag"] = etag(result)
    elif operation == "createScenarioRevision":
        scenario = get_scenario(db, access, params["scenario_id"], lock=True)
        conditional(request, scenario.payload, scenario.current_revision_id)
        if body["parent_revision_id"] != scenario.current_revision_id:
            raise DomainError(
                412,
                "revision_conflict",
                "Parent revision is no longer current",
                current_revision_id=scenario.current_revision_id,
            )
        if scenario.status != "draft":
            raise DomainError(409, "scenario_not_draft", "Only drafts accept new revisions")
        result = save_revision(db, access, scenario, body)
        headers["ETag"] = etag(scenario.payload)
    elif operation == "getScenarioRevision":
        revision = authorized_revision(db, access, params["revision_id"])
        result = revision.payload
        headers["ETag"] = etag(result)
    elif operation == "listScenarioRevisions":
        scenario = get_scenario(db, access, params["scenario_id"])
        result = page(
            db,
            ScenarioRevision,
            select(ScenarioRevision).where(ScenarioRevision.scenario_id == scenario.id),
            params,
            operation,
            access,
            authorize=lambda revision: revision_access(db, access, revision),
        )
    elif operation == "listScenarios":
        access.city(params["city_id"])
        stmt = select(Scenario).where(Scenario.city_id == params["city_id"])
        if params.get("zone_id"):
            stmt = stmt.where(Scenario.zone_id == params["zone_id"])
        result = page(
            db,
            Scenario,
            stmt,
            params,
            operation,
            access,
            authorize=lambda scenario: scenario_access(db, access, scenario),
        )
    elif operation == "createWorkOrder":
        from services.api.work_orders import validate_work_order_target

        access.city(body["city_id"])
        _, _, care_operation, resource_period = validate_work_order_target(
            db, access, body, authorized_revision
        )
        order_id = uid()
        timestamp = now()
        payload = {
            "id": order_id,
            **body,
            "care_operation_id": care_operation["id"] if care_operation else None,
            "resource_period": resource_period,
            "status": "planned",
            "completed_quantity": 0,
            "updated_at": timestamp,
        }
        order = WorkOrderRecord(
            id=order_id,
            city_id=body["city_id"],
            zone_id=body["zone_id"],
            scenario_revision_id=body["scenario_revision_id"],
            care_operation_id=care_operation["id"] if care_operation else None,
            resource_period=resource_period,
            owner_id=access.user.id,
            status="planned",
            payload=payload,
            updated_at=datetime.fromisoformat(timestamp),
        )
        db.add(order)
        db.add(
            WorkOrderStatusEvent(
                id=uid(),
                work_order_id=order_id,
                actor_id=access.user.id,
                payload={
                    "work_order_id": order_id,
                    "from_status": None,
                    "to_status": "planned",
                    "reason": "created",
                    "created_at": timestamp,
                },
                created_at=datetime.fromisoformat(timestamp),
            )
        )
        audit(db, access, "work_order.created", order_id, "WorkOrder")
        result = payload
        headers["ETag"] = etag(result)
    elif operation == "getWorkOrder":
        from services.api.work_orders import get_work_order

        result = get_work_order(db, access, params["work_order_id"]).payload
        headers["ETag"] = etag(result)
    elif operation == "listWorkOrders":
        from services.api.work_orders import work_order_access

        access.city(params["city_id"])
        statement = select(WorkOrderRecord).where(WorkOrderRecord.city_id == params["city_id"])
        if params.get("zone_id"):
            statement = statement.where(WorkOrderRecord.zone_id == params["zone_id"])
        if params.get("status"):
            statement = statement.where(WorkOrderRecord.status == params["status"])
        result = page(
            db,
            WorkOrderRecord,
            statement,
            params,
            operation,
            access,
            authorize=lambda row: work_order_access(access, row),
        )
    elif operation == "transitionWorkOrder":
        from services.api.work_orders import get_work_order, transition_work_order

        order = get_work_order(db, access, params["work_order_id"], lock=True)
        conditional(request, order.payload, order.id)
        result = transition_work_order(
            db,
            access,
            order,
            body["target_status"],
            body["reason"],
            uid(),
            now(),
        )
        audit(
            db,
            access,
            "work_order.transition." + body["target_status"],
            order.id,
            "WorkOrder",
            body["reason"],
        )
        headers["ETag"] = etag(result)
    elif operation == "recordWorkCompletion":
        from services.api.work_orders import get_work_order, record_completion

        order = get_work_order(db, access, params["work_order_id"], lock=True)
        conditional(request, order.payload, order.id)
        result = record_completion(db, access, order, body, uid(), now())
        audit(
            db,
            access,
            "work_completion.corrected" if body.get("correction_of_id") else "work_completion.recorded",
            result["id"],
            "WorkCompletion",
        )
    elif operation == "listWorkCompletions":
        from services.api.work_orders import get_work_order

        access.role("specialist")
        order = get_work_order(db, access, params["work_order_id"])
        result = page(
            db,
            WorkCompletionRecord,
            select(WorkCompletionRecord).where(WorkCompletionRecord.work_order_id == order.id),
            params,
            operation,
            access,
        )
    elif operation == "createCohort":
        from services.api.cohorts import create_cohort

        result = create_cohort(db, access, body, uid())
        audit(db, access, "cohort.created", result["id"], "Cohort")
    elif operation == "listCohorts":
        from services.api.cohorts import cohort_access, cohort_payload

        access.city(params["city_id"])
        statement = select(CohortRecord).where(CohortRecord.city_id == params["city_id"])
        if params.get("zone_id"):
            statement = statement.where(CohortRecord.zone_id == params["zone_id"])
        result = page(
            db,
            CohortRecord,
            statement,
            params,
            operation,
            access,
            authorize=lambda row: cohort_access(access, row),
            serialize=cohort_payload,
        )
    elif operation == "createInspection":
        from services.api.cohorts import create_inspection

        access.city(body["city_id"])
        result = create_inspection(db, access, body, uid(), now())
        audit(db, access, "inspection.created", result["id"], "Inspection")
    elif operation == "listInspections":
        from services.api.cohorts import inspection_access

        access.city(params["city_id"])
        statement = select(InspectionRecord).where(
            InspectionRecord.city_id == params["city_id"]
        )
        if params.get("cohort_id"):
            statement = statement.where(InspectionRecord.cohort_id == params["cohort_id"])
        result = page(
            db,
            InspectionRecord,
            statement,
            params,
            operation,
            access,
            authorize=lambda row: inspection_access(db, access, row),
        )
    elif operation == "recordReplacement":
        from services.api.cohorts import create_replacement

        result = create_replacement(db, access, body, uid())
        audit(db, access, "cohort.replacement_created", result["id"], "Cohort", body["reason"])
    elif operation == "compareForecastObserved":
        from services.api.cohorts import compare_forecast_observed

        result = compare_forecast_observed(db, access, body)
    elif operation == "createChatSession":
        from services.api.chat import create_session

        result = create_session(db, access, body)
    elif operation == "sendChatMessage":
        from services.api.chat import enqueue_message

        result = enqueue_message(db, access, params["session_id"], body)
    elif operation == "listChatMessages":
        from services.api.chat import list_messages

        result = list_messages(db, access, params["session_id"], params)
    elif operation == "getProposal":
        from services.api.proposals import get_proposal

        result = get_proposal(db, access, params["proposal_id"])
    elif operation == "applyProposal":
        from services.api.proposals import apply_proposal

        result, scenario = apply_proposal(db, access, params["proposal_id"], body, request)
        headers["ETag"] = etag(scenario.payload)
    elif operation == "rejectProposal":
        from services.api.proposals import reject_proposal

        result = reject_proposal(db, access, params["proposal_id"], body)
    elif operation == "startExport":
        from services.worker.jobs import enqueue_export

        job = enqueue_export(db, access, body)
        audit(db, access, "export.queued", job.id, "Job")
        result = job.payload
    elif operation == "getExport":
        from services.api.exports import artifact_payload, authorize_artifact
        from services.api.models import ExportArtifactRecord

        artifact = found(db.get(ExportArtifactRecord, params["export_id"]))
        authorize_artifact(db, access, artifact)
        result = artifact_payload(artifact)
    elif operation == "searchAddresses":
        from services.api.addresses import search_addresses

        result = search_addresses(db, access, params)
    elif operation == "listAuditEvents":
        result = page(
            db,
            AuditEvent,
            select(AuditEvent),
            params,
            operation,
            access,
            authorize=lambda event: audit_access(db, access, event),
        )
    elif operation in {"getJob", "cancelJob"}:
        stmt = select(Job).where(Job.id == params["job_id"])
        job = found(db.scalar(stmt.with_for_update() if operation == "cancelJob" else stmt))
        access.city(job.city_id)
        if job.owner_id != access.user.id and access.level < 2:
            raise DomainError(404, "not_found", "Object not found")
        from services.worker.jobs import authorize_job_input

        authorize_job_input(db, access, job)
        if operation == "cancelJob":
            from services.worker.jobs import cancel

            cancel(db, job)
            audit(db, access, "job.cancel_requested", job.id, "Job", body["reason"])
        result = job.payload
    else:
        raise DomainError(503, "operation_not_implemented", "This operation is not available yet")
    return result, headers
