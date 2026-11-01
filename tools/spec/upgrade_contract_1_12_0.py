"""List calculation snapshots of one exact revision and expose export size/media type."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERSION = "1.12.0"
PATH = "/v1/calculations"
MEDIA_TYPES = [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]


def read(name):
    path = ROOT / name
    return path, json.loads(path.read_text(encoding="utf-8"))


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def extend(schemas, ref_prefix):
    schemas["CalculationSnapshotPage"] = {
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "items": {"$ref": f"{ref_prefix}CalculationSnapshot"},
            },
            "next_cursor": {"anyOf": [{"type": "string", "minLength": 1}, {"type": "null"}]},
        },
        "required": ["items", "next_cursor"],
        "additionalProperties": False,
    }
    artifact = schemas["ExportArtifact"]
    artifact["properties"]["byte_size"] = {"type": "integer", "minimum": 1}
    artifact["properties"]["media_type"] = {"type": "string", "enum": MEDIA_TYPES}
    for name in ("byte_size", "media_type"):
        if name not in artifact["required"]:
            artifact["required"].append(name)


domain_path, domain = read("contracts/domain.schema.json")
if domain["$id"].rsplit("/", 1)[-1] not in {"1.11.0", VERSION}:
    raise RuntimeError("contract 1.11.0 is required")
domain["$id"] = f"https://team-vtiposhnik.example/schemas/domain/{VERSION}"
extend(domain["$defs"], "#/$defs/")
write(domain_path, domain)

api_path, api = read("contracts/openapi.json")
api["info"]["version"] = VERSION
api["info"]["description"] = (
    "Canonical API contract 1.12.0. Calculation snapshots of one exact scenario revision are "
    "listed with authorized stable cursors; export artifacts carry server byte size and media type."
)
extend(api["components"]["schemas"], "#/components/schemas/")
problem = {
    "description": (
        "Structured API error; includes 401/403/404/409/412/422/429/503 as applicable."
    ),
    "content": {"application/problem+json": {"schema": {"$ref": "#/components/schemas/Problem"}}},
}
api["paths"][PATH]["get"] = {
    "operationId": "listCalculations",
    "summary": "listCalculations",
    "description": (
        "Snapshots whose scenario_revision_id equals the given revision exactly. The revision "
        "is authorized first, including restricted datasets; cursors are bound to the query."
    ),
    "x-required-role": "viewer",
    "parameters": [
        {
            "name": "scenario_revision_id",
            "in": "query",
            "required": True,
            "schema": {"type": "string", "format": "uuid"},
        },
        {
            "name": "cursor",
            "in": "query",
            "schema": {"type": "string", "minLength": 1},
        },
        {
            "name": "limit",
            "in": "query",
            "schema": {"type": "integer", "minimum": 1, "maximum": 200, "default": 50},
        },
    ],
    "responses": {
        "200": {
            "description": "Successful response",
            "content": {
                "application/json": {
                    "schema": {"$ref": "#/components/schemas/CalculationSnapshotPage"}
                }
            },
        },
        "default": problem,
    },
}
api["paths"][PATH] = {"get": api["paths"][PATH]["get"], "post": api["paths"][PATH]["post"]}
write(api_path, api)

operations_path, operations = read("contracts/operations.json")
entry = {
    "operation_id": "listCalculations",
    "method": "GET",
    "path": PATH,
    "minimum_role": "viewer",
    "request_schema": None,
    "response_schema": "CalculationSnapshotPage",
    "success_status": 200,
}
operations = [item for item in operations if item["operation_id"] != entry["operation_id"]]
index = next(i for i, item in enumerate(operations) if item["operation_id"] == "startCalculation")
operations.insert(index, entry)
write(operations_path, operations)

for name in (
    "contracts/units.json",
    "contracts/metric_keys.json",
    "contracts/problem_codes.json",
):
    path, registry = read(name)
    registry["version"] = VERSION
    write(path, registry)
