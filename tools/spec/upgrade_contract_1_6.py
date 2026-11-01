"""Deterministically upgrade the canonical 1.5 contract to additive 1.6."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERSION = "1.6.0"


def read(name):
    return json.loads((ROOT / name).read_text(encoding="utf-8"))


def write(name, value):
    (ROOT / name).write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


uid = {"type": "string", "format": "uuid"}
text = {"type": "string", "minLength": 1}
datetime = {"type": "string", "format": "date-time"}

factor = {
    "type": "object",
    "properties": {
        "factor": text,
        "label": text,
        "group": {"type": "string", "enum": ["need", "readiness"]},
        "formula": text,
        "unit": {"const": "1"},
        "minimum": {"const": 0},
        "maximum": {"const": 1},
    },
    "required": ["factor", "label", "group", "formula", "unit", "minimum", "maximum"],
    "additionalProperties": False,
}
normalization = {
    "type": "object",
    "properties": {
        "id": uid,
        "name": text,
        "method_version": text,
        "factors": {
            "type": "array",
            "items": {"$ref": "#/$defs/PriorityNormalizationFactor"},
            "minItems": 1,
        },
        "created_at": datetime,
    },
    "required": ["id", "name", "method_version", "factors", "created_at"],
    "additionalProperties": False,
}
page = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {"$ref": "#/$defs/PriorityNormalization"},
        },
        "next_cursor": {"anyOf": [text, {"type": "null"}]},
    },
    "required": ["items", "next_cursor"],
    "additionalProperties": False,
}

domain = read("contracts/domain.schema.json")
current = domain["$id"].rsplit("/", 1)[-1]
if current not in {"1.5.0", VERSION}:
    raise RuntimeError(f"expected contract 1.5.0 or {VERSION}, got {current}")
domain["$id"] = f"https://team-vtiposhnik.example/schemas/domain/{VERSION}"
domain["$defs"]["PriorityNormalizationFactor"] = factor
domain["$defs"]["PriorityNormalization"] = normalization
domain["$defs"]["PriorityNormalizationPage"] = page
write("contracts/domain.schema.json", domain)

api = read("contracts/openapi.json")
api["info"]["version"] = VERSION
api["info"]["description"] = (
    "Canonical API contract 1.6.0. Priority normalization is discoverable and immutable; "
    "unknown source values remain explicit and server calculations are authoritative."
)
schemas = json.loads(
    json.dumps(
        {
            "PriorityNormalizationFactor": factor,
            "PriorityNormalization": normalization,
            "PriorityNormalizationPage": page,
        }
    ).replace("#/$defs/", "#/components/schemas/")
)
api["components"]["schemas"].update(schemas)
api["paths"]["/v1/priority-normalizations"] = {
    "get": {
        "operationId": "listPriorityNormalizations",
        "summary": "listPriorityNormalizations",
        "x-required-role": "viewer",
        "parameters": [],
        "responses": {
            "200": {
                "description": "Successful response",
                "content": {
                    "application/json": {
                        "schema": {"$ref": "#/components/schemas/PriorityNormalizationPage"}
                    }
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
    }
}
write("contracts/openapi.json", api)

operations = read("contracts/operations.json")
operation = {
    "operation_id": "listPriorityNormalizations",
    "method": "GET",
    "path": "/v1/priority-normalizations",
    "minimum_role": "viewer",
    "request_schema": None,
    "response_schema": "PriorityNormalizationPage",
    "success_status": 200,
}
operations = [item for item in operations if item["operation_id"] != operation["operation_id"]]
operations.append(operation)
write("contracts/operations.json", operations)

for registry in ["contracts/units.json", "contracts/metric_keys.json", "contracts/problem_codes.json"]:
    value = read(registry)
    value["version"] = VERSION
    if registry.endswith("problem_codes.json"):
        additions = [
            ("priority_normalization_unavailable", 422, "Версия нормализации приоритетов недоступна"),
            ("priority_weights_invalid", 422, "Веса приоритетов недопустимы"),
            ("priority_zones_invalid", 422, "Список зон приоритетов недопустим"),
        ]
        known = {item["code"] for item in value["codes"]}
        value["codes"].extend(
            {"code": code, "status": status, "title_ru": title}
            for code, status, title in additions
            if code not in known
        )
    write(registry, value)
