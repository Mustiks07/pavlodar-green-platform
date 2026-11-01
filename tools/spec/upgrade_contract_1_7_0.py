"""Add an authorized, server-owned diff for immutable program revisions."""

import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERSION = "1.7.0"
PATH = "/v1/programs/{program_id}/revisions/{base_revision_id}/diff/{target_revision_id}"


def read(name):
    path = ROOT / name
    return path, json.loads(path.read_text(encoding="utf-8"))


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def diff_schema(prefix):
    uid = {"type": "string", "format": "uuid"}
    ids = {"type": "array", "items": uid}
    nullable_number = {"anyOf": [{"type": "number"}, {"type": "null"}]}
    nullable_money = {
        "anyOf": [{"$ref": prefix + "SignedMoney"}, {"type": "null"}]
    }
    properties = {
        "program_id": uid,
        "base_revision": {"$ref": prefix + "ProgramRevision"},
        "target_revision": {"$ref": prefix + "ProgramRevision"},
        "added_scenario_revision_ids": ids,
        "removed_scenario_revision_ids": ids,
        "added_calculation_snapshot_ids": ids,
        "removed_calculation_snapshot_ids": ids,
        "changed_input_fields": {
            "type": "array",
            "items": {"type": "string", "minLength": 1},
        },
        "objective_delta": nullable_number,
        "capital_delta": nullable_money,
    }
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties),
        "additionalProperties": False,
    }


domain_path, domain = read("contracts/domain.schema.json")
if domain["$id"].rsplit("/", 1)[-1] not in {"1.6.2", VERSION}:
    raise RuntimeError("contract 1.6.2 is required")
domain["$id"] = f"https://team-vtiposhnik.example/schemas/domain/{VERSION}"
domain["$defs"]["SignedMoney"] = {
    "type": "string",
    "pattern": r"^-?(0|[1-9][0-9]*)\.[0-9]{2}$",
    "description": "Exact signed KZT delta; Decimal in server, never binary floating point accounting.",
}
domain["$defs"]["ProgramRevisionDiff"] = diff_schema("#/$defs/")
write(domain_path, domain)

api_path, api = read("contracts/openapi.json")
api["info"]["version"] = VERSION
api["info"]["description"] = (
    "Canonical API contract 1.7.0. Program revision differences are authorized and "
    "computed by the server from immutable revisions; client-side formulas are non-authoritative."
)
api["components"]["schemas"]["SignedMoney"] = copy.deepcopy(
    domain["$defs"]["SignedMoney"]
)
api["components"]["schemas"]["ProgramRevisionDiff"] = diff_schema(
    "#/components/schemas/"
)
problem = {
    "description": "Structured API error; includes 401/403/404/409/412/422/429/503 as applicable.",
    "content": {
        "application/problem+json": {
            "schema": {"$ref": "#/components/schemas/Problem"}
        }
    },
}
parameters = [
    {
        "name": name,
        "in": "path",
        "required": True,
        "schema": {"type": "string", "format": "uuid"},
    }
    for name in ("program_id", "base_revision_id", "target_revision_id")
]
api["paths"][PATH] = {
    "get": {
        "operationId": "getProgramRevisionDiff",
        "summary": "getProgramRevisionDiff",
        "x-required-role": "viewer",
        "parameters": parameters,
        "responses": {
            "200": {
                "description": "Exact server-owned diff of two authorized immutable revisions from one program.",
                "content": {
                    "application/json": {
                        "schema": {"$ref": "#/components/schemas/ProgramRevisionDiff"}
                    }
                },
            },
            "default": problem,
        },
    }
}
write(api_path, api)

operations_path, operations = read("contracts/operations.json")
entry = {
    "operation_id": "getProgramRevisionDiff",
    "method": "GET",
    "path": PATH,
    "minimum_role": "viewer",
    "request_schema": None,
    "response_schema": "ProgramRevisionDiff",
    "success_status": 200,
}
operations = [item for item in operations if item["operation_id"] != entry["operation_id"]]
index = next(
    i + 1 for i, item in enumerate(operations) if item["operation_id"] == "getProgramRevision"
)
operations.insert(index, entry)
write(operations_path, operations)

for name in ("contracts/units.json", "contracts/metric_keys.json", "contracts/problem_codes.json"):
    path, registry = read(name)
    registry["version"] = VERSION
    write(path, registry)
