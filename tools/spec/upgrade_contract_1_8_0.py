"""Add evidence-backed initial cohort creation and normalized work-order lineage."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERSION = "1.8.0"
PATH = "/v1/cohorts"


def read(name):
    path = ROOT / name
    return path, json.loads(path.read_text(encoding="utf-8"))


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def uid():
    return {"type": "string", "format": "uuid"}


cohort_create = {
    "type": "object",
    "properties": {
        "work_order_id": uid(),
        "placement_id": uid(),
        "planting_date": {"type": "string", "format": "date"},
    },
    "required": ["work_order_id", "placement_id", "planting_date"],
    "additionalProperties": False,
}

domain_path, domain = read("contracts/domain.schema.json")
if domain["$id"].rsplit("/", 1)[-1] not in {"1.7.0", VERSION}:
    raise RuntimeError("contract 1.7.0 is required")
domain["$id"] = f"https://team-vtiposhnik.example/schemas/domain/{VERSION}"
domain["$defs"]["CohortCreate"] = cohort_create
cohort = domain["$defs"]["Cohort"]
cohort["properties"]["source_work_order_id"] = uid()
if "source_work_order_id" not in cohort["required"]:
    index = cohort["required"].index("latest_inspection_id")
    cohort["required"].insert(index, "source_work_order_id")
write(domain_path, domain)

api_path, api = read("contracts/openapi.json")
api["info"]["version"] = VERSION
api["info"]["description"] = (
    "Canonical API contract 1.8.0. Initial cohorts are created only from completed, "
    "placement-bound work evidence; server calculations and immutable lineage are authoritative."
)
api["components"]["schemas"]["CohortCreate"] = cohort_create
api_cohort = api["components"]["schemas"]["Cohort"]
api_cohort["properties"]["source_work_order_id"] = uid()
if "source_work_order_id" not in api_cohort["required"]:
    index = api_cohort["required"].index("latest_inspection_id")
    api_cohort["required"].insert(index, "source_work_order_id")
operation = {
    "operationId": "createCohort",
    "summary": "createCohort",
    "x-required-role": "specialist",
    "parameters": [
        {
            "name": "X-CSRF-Token",
            "in": "header",
            "required": True,
            "schema": {"type": "string", "minLength": 1},
        },
        {
            "name": "Idempotency-Key",
            "in": "header",
            "required": True,
            "schema": {"type": "string", "minLength": 8, "maxLength": 128},
        },
    ],
    "responses": {
        "201": {
            "description": "Creates one immutable planting cohort from one completed piece-based work order and its exact scenario placement.",
            "content": {
                "application/json": {"schema": {"$ref": "#/components/schemas/Cohort"}}
            },
        },
        "default": {
            "description": "Structured API error; includes 401/403/404/409/412/422/429/503 as applicable.",
            "content": {
                "application/problem+json": {
                    "schema": {"$ref": "#/components/schemas/Problem"}
                }
            },
        },
    },
    "requestBody": {
        "required": True,
        "content": {
            "application/json": {"schema": {"$ref": "#/components/schemas/CohortCreate"}}
        },
    },
}
api["paths"][PATH]["post"] = operation
write(api_path, api)

operations_path, operations = read("contracts/operations.json")
entry = {
    "operation_id": "createCohort",
    "method": "POST",
    "path": PATH,
    "minimum_role": "specialist",
    "request_schema": "CohortCreate",
    "response_schema": "Cohort",
    "success_status": 201,
}
operations = [item for item in operations if item["operation_id"] != entry["operation_id"]]
index = next(i for i, item in enumerate(operations) if item["operation_id"] == "listCohorts")
operations.insert(index, entry)
write(operations_path, operations)

for name in ("contracts/units.json", "contracts/metric_keys.json", "contracts/problem_codes.json"):
    path, registry = read(name)
    registry["version"] = VERSION
    write(path, registry)
