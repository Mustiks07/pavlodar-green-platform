"""Admit the GeoJSON multi-point and multi-line types already handled by map delivery."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERSION = "1.13.0"


def read(name):
    path = ROOT / name
    return path, json.loads(path.read_text(encoding="utf-8"))


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def extend(schemas, ref_prefix):
    coordinate = {"$ref": f"{ref_prefix}Coordinate"}
    schemas["MultiPoint"] = {
        "type": "object",
        "properties": {
            "type": {"const": "MultiPoint"},
            "coordinates": {"type": "array", "items": coordinate, "minItems": 1},
        },
        "required": ["type", "coordinates"],
        "additionalProperties": False,
    }
    schemas["MultiLineString"] = {
        "type": "object",
        "properties": {
            "type": {"const": "MultiLineString"},
            "coordinates": {
                "type": "array",
                "items": {
                    "type": "array",
                    "items": coordinate,
                    "minItems": 2,
                },
                "minItems": 1,
            },
        },
        "required": ["type", "coordinates"],
        "additionalProperties": False,
    }
    geometry = schemas["Geometry"]["oneOf"]
    for name in ("MultiPoint", "MultiLineString"):
        reference = {"$ref": f"{ref_prefix}{name}"}
        if reference not in geometry:
            geometry.append(reference)


domain_path, domain = read("contracts/domain.schema.json")
if domain["$id"].rsplit("/", 1)[-1] not in {"1.12.0", VERSION}:
    raise RuntimeError("contract 1.12.0 is required")
domain["$id"] = f"https://team-vtiposhnik.example/schemas/domain/{VERSION}"
extend(domain["$defs"], "#/$defs/")
write(domain_path, domain)

api_path, api = read("contracts/openapi.json")
if api["info"]["version"] not in {"1.12.0", VERSION}:
    raise RuntimeError("OpenAPI 1.12.0 is required")
api["info"]["version"] = VERSION
api["info"]["description"] = (
    "Canonical API contract 1.13.0. GeoJSON MultiPoint and MultiLineString are accepted "
    "without splitting source objects; all 1.12.0 operations remain compatible."
)
extend(api["components"]["schemas"], "#/components/schemas/")
write(api_path, api)

for name in (
    "contracts/units.json",
    "contracts/metric_keys.json",
    "contracts/problem_codes.json",
):
    path, registry = read(name)
    registry["version"] = VERSION
    write(path, registry)
