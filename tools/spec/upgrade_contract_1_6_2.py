"""Expose exact calculation lineage on immutable program revisions."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERSION = "1.6.2"


def update(path):
    target = ROOT / path
    return target, json.loads(target.read_text(encoding="utf-8"))


def write(target, value):
    target.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


domain_path, domain = update("contracts/domain.schema.json")
if domain["$id"].rsplit("/", 1)[-1] not in {"1.6.1", VERSION}:
    raise RuntimeError("contract 1.6.1 is required")
domain["$id"] = f"https://team-vtiposhnik.example/schemas/domain/{VERSION}"
schema = domain["$defs"]["ProgramRevision"]
schema["properties"]["calculation_snapshot_ids"] = {
    "type": "array",
    "items": {"type": "string", "format": "uuid"},
}
if "calculation_snapshot_ids" not in schema["required"]:
    index = schema["required"].index("selected_scenario_revision_ids") + 1
    schema["required"].insert(index, "calculation_snapshot_ids")
write(domain_path, domain)

api_path, api = update("contracts/openapi.json")
api["info"]["version"] = VERSION
api["info"]["description"] = (
    "Canonical API contract 1.6.2. Program revisions expose exact calculation lineage; "
    "unknown values remain explicit and server calculations are authoritative."
)
schema = api["components"]["schemas"]["ProgramRevision"]
schema["properties"]["calculation_snapshot_ids"] = {
    "type": "array",
    "items": {"type": "string", "format": "uuid"},
}
if "calculation_snapshot_ids" not in schema["required"]:
    index = schema["required"].index("selected_scenario_revision_ids") + 1
    schema["required"].insert(index, "calculation_snapshot_ids")
write(api_path, api)

for name in ["contracts/units.json", "contracts/metric_keys.json", "contracts/problem_codes.json"]:
    path, registry = update(name)
    registry["version"] = VERSION
    write(path, registry)
