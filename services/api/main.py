import copy
import json
import logging
from datetime import UTC, datetime
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from jsonschema import Draft202012Validator, FormatChecker, ValidationError
from pydantic import ValidationError as PydanticValidationError
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException

from packages.domain.contracts import OPENAPI, OPERATIONS, validate
from packages.domain.errors import DomainError
from services.api import auth
from services.api.archives import get_map_archive
from services.api.config import settings
from services.api.db import session
from services.api.exports import download_export
from services.api.job_events import stream_job_events
from services.api.models import Idempotency
from services.api.security import authenticate, digest
from services.api.tiles import get_map_tile
from services.api.uploads import put_upload_content
from services.api.use_cases import canonical_hash, execute

IMPLEMENTED = {
    "getReadiness",
    "getCurrentUser",
    "listCities",
    "getCity",
    "listDatasets",
    "createDataset",
    "createUploadTicket",
    "putUploadContent",
    "startImport",
    "listDatasetVersions",
    "getQualityReport",
    "publishDatasetVersion",
    "rejectDatasetVersion",
    "listZones",
    "createZone",
    "getZone",
    "getZoneVersion",
    "updateZone",
    "getZoneContext",
    "listMapLayers",
    "listCityPrincipals",
    "listDatasetGrants",
    "grantDatasetAccess",
    "revokeDatasetAccess",
    "getMapFeature",
    "searchAddresses",
    "listProblems",
    "dismissProblem",
    "listPlants",
    "getPlant",
    "createPlant",
    "createPlantVersion",
    "listStock",
    "listModelVersions",
    "getModelVersion",
    "listRuleVersions",
    "getRuleVersion",
    "recommendPlants",
    "listRates",
    "createRateVersion",
    "listCoefficients",
    "createCoefficientVersion",
    "calculateFast",
    "startCalculation",
    "listCalculations",
    "getCalculation",
    "getCalculationManifest",
    "compareScenarios",
    "listPriorityNormalizations",
    "calculatePriorities",
    "getPriorityResult",
    "createProgram",
    "getProgram",
    "updateProgramDraft",
    "listPrograms",
    "optimizeProgram",
    "listProgramRevisions",
    "getProgramRevision",
    "getProgramRevisionDiff",
    "transitionProgram",
    "startShadowRun",
    "startThermalRun",
    "getSpatialResult",
    "getSpatialResultArtifact",
    "getMapTile",
    "getMapArchive",
    "listSourceReadiness",
    "createScenario",
    "listScenarios",
    "getScenario",
    "createScenarioRevision",
    "transitionScenario",
    "listScenarioRevisions",
    "getScenarioRevision",
    "listAuditEvents",
    "getJob",
    "cancelJob",
    "streamJobEvents",
    "createWorkOrder",
    "listWorkOrders",
    "getWorkOrder",
    "transitionWorkOrder",
    "recordWorkCompletion",
    "listWorkCompletions",
    "createCohort",
    "listCohorts",
    "createInspection",
    "listInspections",
    "recordReplacement",
    "compareForecastObserved",
    "startExport",
    "getExport",
    "downloadExport",
    "createChatSession",
    "sendChatMessage",
    "listChatMessages",
    "getProposal",
    "applyProposal",
    "rejectProposal",
    "startOidcLogin",
    "completeOidcLogin",
    "logout",
}
CUSTOM_IMPLEMENTED = {
    "putUploadContent",
    "getMapTile",
    "getMapArchive",
    "streamJobEvents",
    "downloadExport",
}
app = FastAPI(title="Pavlodar foundation", docs_url="/docs", redoc_url=None)
logger = logging.getLogger("pavlodar.api")


@app.exception_handler(HTTPException)
async def http_problem(request, error):
    return problem(
        DomainError(error.status_code, "http_error", "Requested resource or method is unavailable"),
        request.state.request_id,
    )


def problem(error, request_id):
    value = {
        "type": "https://team-vtiposhnik.example/problems/" + error.code,
        "title": error.code,
        "status": error.status,
        "detail": error.detail,
        "code": error.code,
        "request_id": request_id,
        "current_revision_id": error.current_revision_id,
        "field_errors": error.field_errors,
        "blockers": error.blockers,
    }
    validate("Problem", value)
    return JSONResponse(
        value,
        status_code=error.status,
        media_type="application/problem+json",
        headers=error.headers,
    )


@app.middleware("http")
async def errors_and_headers(request: Request, call_next):
    request_id = str(uuid4())
    request.state.request_id = request_id
    try:
        response = await call_next(request)
    except DomainError as error:
        response = problem(error, request_id)
    except SQLAlchemyError:
        response = problem(
            DomainError(503, "storage_unavailable", "Storage is temporarily unavailable"),
            request_id,
        )
    except Exception:  # noqa: BLE001 - trust boundary: never expose secret-bearing exceptions
        response = problem(
            DomainError(500, "internal_error", "Request failed; contact support with request_id"),
            request_id,
        )
    response.headers["X-Request-ID"] = request_id
    if "Cache-Control" not in response.headers:
        response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    # Do not log query, request bodies, cookies, codes or provider tokens.
    logger.info(
        json.dumps(
            {"request_id": request_id, "method": request.method, "status": response.status_code}
        )
    )
    return response


def parameters(request, definition):
    result = {}
    for parameter in definition["parameters"]:
        name, location = parameter["name"], parameter["in"]
        source = {
            "path": request.path_params,
            "query": request.query_params,
            "header": request.headers,
        }[location]
        value = source.get(name)
        if value is None:
            if parameter.get("required"):
                raise DomainError(422, "missing_parameter", f"Missing {name}")
            continue
        schema = parameter["schema"]
        if schema.get("type") == "integer":
            try:
                value = int(value)
            except ValueError:
                raise DomainError(422, "invalid_parameter", f"Invalid {name}") from None
        elif schema.get("type") == "boolean":
            normalized = value.lower()
            if normalized not in {"true", "false"}:
                raise DomainError(422, "invalid_parameter", f"Invalid {name}")
            value = normalized == "true"
        try:
            Draft202012Validator(schema, format_checker=FormatChecker()).validate(value)
        except ValidationError:
            raise DomainError(422, "invalid_parameter", f"Invalid {name}") from None
        if location != "header":
            result[name] = value
    return result


def handle_sync(request, operation, body):
    operation_id = operation["operation_id"]
    config = settings()
    if operation_id == "getReadiness":
        with session() as db:
            db.execute(text("SELECT postgis_version()"))
            version = db.scalar(text("SELECT version_num FROM alembic_version"))
            if version != "0035_chat_report_jobs":
                raise DomainError(503, "migration_required", "Database schema is not ready")
        return JSONResponse({"status": "ok", "release": config.release})
    definition = OPENAPI["paths"][operation["path"]][operation["method"].lower()]
    with session() as db, db.begin():
        access = authenticate(db, request)
        access.role(operation["minimum_role"])
        if request.method not in {"GET", "HEAD"}:
            access.mutation(request)
        params = parameters(request, definition)
        if operation["request_schema"]:
            try:
                validate(operation["request_schema"], body)
            except ValidationError as error:
                path = "/" + "/".join(
                    str(part).replace("~", "~0").replace("/", "~1") for part in error.absolute_path
                )
                raise DomainError(
                    422,
                    "invalid_body",
                    "Body does not satisfy the canonical schema",
                    field_errors=[
                        {
                            "path": path or "/",
                            "code": "schema_validation",
                            "message": "Значение не соответствует каноническому контракту",
                        }
                    ],
                ) from None
            except PydanticValidationError as error:
                location = error.errors()[0].get("loc", ()) if error.errors() else ()
                path = "/" + "/".join(str(part) for part in location)
                raise DomainError(
                    422,
                    "invalid_body",
                    "Body does not satisfy the generated domain model",
                    field_errors=[
                        {
                            "path": path or "/",
                            "code": "model_validation",
                            "message": "Значение не соответствует типизированной модели",
                        }
                    ],
                ) from None
        scope = None
        if request.method not in {"GET", "HEAD"}:
            scope = digest(
                f"{access.user.id}|{request.method}|{request.url.path}|{request.headers['idempotency-key']}"
            )
            # Database transaction lock serializes concurrent retries, including across API processes.
            lock_key = int(scope[:16], 16)
            if lock_key >= 2**63:
                lock_key -= 2**64
            db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": lock_key})
            request_hash = canonical_hash(
                {"body": body, "params": params, "if_match": request.headers.get("if-match")}
            )
            previous = db.get(Idempotency, scope)
            if previous:
                if previous.request_hash != request_hash:
                    raise DomainError(
                        409, "idempotency_conflict", "Key already used with a different request"
                    )
                # Recheck current resource grants before returning a stored response.
                from services.api.replay import authorize_replay

                authorize_replay(db, access, operation_id, previous.response)
                return (
                    Response(status_code=204)
                    if previous.status == 204
                    else JSONResponse(
                        previous.response, status_code=previous.status, headers=previous.headers
                    )
                )
        if operation_id == "logout":
            db.delete(access.session)
            result, headers = None, {}
        else:
            result, headers = execute(operation_id, db, access, params, body, request)
        if operation["response_schema"]:
            validate(operation["response_schema"], result)
        status = operation["success_status"]
        content = definition["responses"].get(str(status), {}).get("content", {})
        media_type = next(iter(content), "application/json")
        if scope:
            db.add(
                Idempotency(
                    scope=scope,
                    request_hash=request_hash,
                    status=status,
                    response=result,
                    headers=headers,
                    created_at=datetime.now(UTC),
                )
            )
        response = (
            Response(status_code=status)
            if status == 204
            else JSONResponse(result, status_code=status, headers=headers, media_type=media_type)
        )
        if operation_id == "logout":
            response.delete_cookie("pavlodar_session", path="/")
        return response


def endpoint(operation):
    async def handler(request: Request):
        if operation["operation_id"] == "startOidcLogin":
            return await auth.login(request)
        if operation["operation_id"] == "completeOidcLogin":
            return await auth.callback(request)
        body = None
        if operation["request_schema"]:
            if request.headers.get("content-type", "").split(";", 1)[0] != "application/json":
                raise DomainError(415, "unsupported_content_type", "Expected application/json")
            # Bound JSON before parsing; uploads have their own pipeline in WP-03.
            data = bytearray()
            async for chunk in request.stream():
                data.extend(chunk)
                if len(data) > 2_000_000:
                    raise DomainError(413, "body_too_large", "JSON body exceeds 2 MB")
            try:
                body = json.loads(data)
                json.dumps(body, allow_nan=False)
            except (ValueError, UnicodeDecodeError):
                raise DomainError(422, "invalid_json", "Body must be valid UTF-8 JSON") from None
        return await run_in_threadpool(handle_sync, request, operation, body)

    return handler


for operation in OPERATIONS:
    if operation["operation_id"] in IMPLEMENTED - CUSTOM_IMPLEMENTED:
        app.add_api_route(
            operation["path"],
            endpoint(operation),
            methods=[operation["method"]],
            operation_id=operation["operation_id"],
            name=operation["operation_id"],
        )

app.add_api_route(
    "/v1/uploads/{upload_id}",
    put_upload_content,
    methods=["PUT"],
    operation_id="putUploadContent",
    name="putUploadContent",
    status_code=204,
)
app.add_api_route(
    "/v1/map/tiles/{layer_id}/{z}/{x}/{y}.mvt",
    get_map_tile,
    methods=["GET"],
    operation_id="getMapTile",
    name="getMapTile",
)
app.add_api_route(
    "/v1/map/archives/{layer_id}.pmtiles",
    get_map_archive,
    methods=["GET"],
    operation_id="getMapArchive",
    name="getMapArchive",
)
app.add_api_route(
    "/v1/jobs/{job_id}/events",
    stream_job_events,
    methods=["GET"],
    operation_id="streamJobEvents",
    name="streamJobEvents",
)
app.add_api_route(
    "/v1/exports/{export_id}/download",
    download_export,
    methods=["GET"],
    operation_id="downloadExport",
    name="downloadExport",
)


def implemented_openapi():
    spec = copy.deepcopy(OPENAPI)
    registered = {r.operation_id for r in app.routes if hasattr(r, "operation_id")}
    spec["paths"] = {
        path: {
            method: definition
            for method, definition in methods.items()
            if definition.get("operationId") in registered
        }
        for path, methods in spec["paths"].items()
    }
    spec["paths"] = {path: methods for path, methods in spec["paths"].items() if methods}
    canonical = {
        definition["operationId"]
        for methods in OPENAPI["paths"].values()
        for definition in methods.values()
    }
    spec["info"]["description"] = (
        "Complete implemented canonical API for the Pavlodar urban greening platform."
        if registered >= canonical
        else "Implemented API subset. Operations not present in this deployment are not advertised."
    )
    return spec


app.openapi = implemented_openapi
