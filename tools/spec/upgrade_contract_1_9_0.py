"""Add exact cohort placement lineage and server-owned forecast/observed comparison."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERSION = "1.9.0"
PATH = "/v1/forecast-observed"


def read(name):
    path = ROOT / name
    return path, json.loads(path.read_text(encoding="utf-8"))


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def uid():
    return {"type": "string", "format": "uuid"}


def nullable(value):
    return {"anyOf": [value, {"type": "null"}]}


request = {
    "type": "object",
    "properties": {
        "cohort_id": uid(),
        "calculation_id": uid(),
        "inspection_id": uid(),
        "horizon_year": {"type": "integer", "minimum": 1, "maximum": 3},
    },
    "required": ["cohort_id", "calculation_id", "inspection_id", "horizon_year"],
    "additionalProperties": False,
}
result_properties = {
    "cohort_id": uid(),
    "placement_id": uid(),
    "calculation_id": uid(),
    "inspection_id": uid(),
    "horizon_year": {"type": "integer", "minimum": 1, "maximum": 3},
    "method_version": {"type": "string", "minLength": 1},
    "date_offset_days": {"type": "integer", "minimum": 0},
    "forecast_probability": nullable({"type": "number", "minimum": 0, "maximum": 1}),
    "forecast_expected_alive": nullable({"type": "number", "minimum": 0}),
    "observed_survival_probability": nullable(
        {"type": "number", "minimum": 0, "maximum": 1}
    ),
    "observed_alive": {"type": "integer", "minimum": 0},
    "observed_dead": {"type": "integer", "minimum": 0},
    "observed_unknown": {"type": "integer", "minimum": 0},
    "observation_coverage": {"type": "number", "minimum": 0, "maximum": 1},
    "probability_delta": nullable({"type": "number", "minimum": -1, "maximum": 1}),
    "comparable": {"type": "boolean"},
    "data_gaps": {"type": "array", "items": {"$ref": "#/$defs/DataGap"}},
}
domain_result = {
    "type": "object",
    "properties": result_properties,
    "required": list(result_properties),
    "additionalProperties": False,
}

domain_path, domain = read("contracts/domain.schema.json")
if domain["$id"].rsplit("/", 1)[-1] not in {"1.8.0", VERSION}:
    raise RuntimeError("contract 1.8.0 is required")
domain["$id"] = f"https://team-vtiposhnik.example/schemas/domain/{VERSION}"
cohort = domain["$defs"]["Cohort"]
cohort["properties"]["placement_id"] = uid()
if "placement_id" not in cohort["required"]:
    cohort["required"].insert(cohort["required"].index("initial_quantity"), "placement_id")
domain["$defs"]["ForecastObservedRequest"] = request
domain["$defs"]["ForecastObservedResult"] = domain_result
write(domain_path, domain)

api_path, api = read("contracts/openapi.json")
api["info"]["version"] = VERSION
api["info"]["description"] = (
    "Canonical API contract 1.9.0. Forecast/observed comparisons are server-owned, "
    "placement-bound and preserve unknown or non-comparable values explicitly."
)
api_cohort = api["components"]["schemas"]["Cohort"]
api_cohort["properties"]["placement_id"] = uid()
if "placement_id" not in api_cohort["required"]:
    api_cohort["required"].insert(api_cohort["required"].index("initial_quantity"), "placement_id")
api["components"]["schemas"]["ForecastObservedRequest"] = request
api_result = json.loads(json.dumps(domain_result).replace("#/$defs/", "#/components/schemas/"))
api["components"]["schemas"]["ForecastObservedResult"] = api_result
api["paths"][PATH] = {
    "post": {
        "operationId": "compareForecastObserved",
        "summary": "compareForecastObserved",
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
            "200": {
                "description": "Placement-bound comparison. comparable=false and data_gaps preserve incomplete coverage, timing or model evidence.",
                "content": {
                    "application/json": {
                        "schema": {"$ref": "#/components/schemas/ForecastObservedResult"}
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
        "requestBody": {
            "required": True,
            "content": {
                "application/json": {
                    "schema": {"$ref": "#/components/schemas/ForecastObservedRequest"}
                }
            },
        },
    }
}
write(api_path, api)

operations_path, operations = read("contracts/operations.json")
entry = {
    "operation_id": "compareForecastObserved",
    "method": "POST",
    "path": PATH,
    "minimum_role": "specialist",
    "request_schema": "ForecastObservedRequest",
    "response_schema": "ForecastObservedResult",
    "success_status": 200,
}
operations = [item for item in operations if item["operation_id"] != entry["operation_id"]]
index = next(i + 1 for i, item in enumerate(operations) if item["operation_id"] == "recordReplacement")
operations.insert(index, entry)
write(operations_path, operations)

for name in ("contracts/units.json", "contracts/metric_keys.json", "contracts/problem_codes.json"):
    path, registry = read(name)
    registry["version"] = VERSION
    write(path, registry)
