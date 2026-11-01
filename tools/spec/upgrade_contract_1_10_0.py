"""Bind work orders to care operations and actual calendar resource evidence."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERSION = "1.10.0"


def read(name):
    path = ROOT / name
    return path, json.loads(path.read_text(encoding="utf-8"))


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def nullable(value):
    return {"anyOf": [value, {"type": "null"}]}


uid = {"type": "string", "format": "uuid"}
text = {"type": "string", "minLength": 1}

domain_path, domain = read("contracts/domain.schema.json")
if domain["$id"].rsplit("/", 1)[-1] not in {"1.9.0", VERSION}:
    raise RuntimeError("contract 1.9.0 is required")
domain["$id"] = f"https://team-vtiposhnik.example/schemas/domain/{VERSION}"
schemas = domain["$defs"]
schemas["WorkOrderCreate"]["properties"]["care_operation_id"] = nullable(uid)
schemas["WorkOrder"]["properties"]["care_operation_id"] = nullable(uid)
schemas["WorkOrder"]["properties"]["resource_period"] = nullable(text)
schemas["WorkCompletionCreate"]["properties"]["actual_care_cost"] = nullable(
    {"$ref": "#/$defs/Money"}
)
schemas["WorkCompletion"]["properties"]["actual_care_cost"] = nullable(
    {"$ref": "#/$defs/Money"}
)
write(domain_path, domain)

api_path, api = read("contracts/openapi.json")
api["info"]["version"] = VERSION
api["info"]["description"] = (
    "Canonical API contract 1.10.0. Care work orders bind to frozen care operations; "
    "actual resource evidence is checked server-side against immutable scenario limits."
)
schemas = api["components"]["schemas"]
schemas["WorkOrderCreate"]["properties"]["care_operation_id"] = nullable(uid)
schemas["WorkOrder"]["properties"]["care_operation_id"] = nullable(uid)
schemas["WorkOrder"]["properties"]["resource_period"] = nullable(text)
schemas["WorkCompletionCreate"]["properties"]["actual_care_cost"] = nullable(
    {"$ref": "#/components/schemas/Money"}
)
schemas["WorkCompletion"]["properties"]["actual_care_cost"] = nullable(
    {"$ref": "#/components/schemas/Money"}
)
write(api_path, api)

for name in ("contracts/units.json", "contracts/metric_keys.json", "contracts/problem_codes.json"):
    path, registry = read(name)
    registry["version"] = VERSION
    write(path, registry)
