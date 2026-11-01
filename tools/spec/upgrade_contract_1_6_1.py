"""Add the optional immutable priority reference required by program optimization."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERSION = "1.6.1"


def update(path):
    target = ROOT / path
    value = json.loads(target.read_text(encoding="utf-8"))
    return target, value


def write(target, value):
    target.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


domain_path, domain = update("contracts/domain.schema.json")
if domain["$id"].rsplit("/", 1)[-1] not in {"1.6.0", VERSION}:
    raise RuntimeError("contract 1.6.0 is required")
domain["$id"] = f"https://team-vtiposhnik.example/schemas/domain/{VERSION}"
program = domain["$defs"]["ProgramCreate"]
program["properties"]["priority_result_id"] = {
    "anyOf": [{"type": "string", "format": "uuid"}, {"type": "null"}]
}
write(domain_path, domain)

api_path, api = update("contracts/openapi.json")
api["info"]["version"] = VERSION
api["info"]["description"] = (
    "Canonical API contract 1.6.1. Program optimization can freeze an immutable priority "
    "result; unknown values remain explicit and server calculations are authoritative."
)
api["components"]["schemas"]["ProgramCreate"]["properties"]["priority_result_id"] = {
    "anyOf": [{"type": "string", "format": "uuid"}, {"type": "null"}]
}
api["components"]["schemas"]["Program"]["properties"]["priority_result_id"] = {
    "anyOf": [{"type": "string", "format": "uuid"}, {"type": "null"}]
}
domain["$defs"]["Program"]["properties"]["priority_result_id"] = {
    "anyOf": [{"type": "string", "format": "uuid"}, {"type": "null"}]
}
write(domain_path, domain)
write(api_path, api)

for name in ["contracts/units.json", "contracts/metric_keys.json", "contracts/problem_codes.json"]:
    path, registry = update(name)
    registry["version"] = VERSION
    if name.endswith("problem_codes.json") and not any(
        item["code"] == "program_priority_invalid" for item in registry["codes"]
    ):
        registry["codes"].append(
            {
                "code": "program_priority_invalid",
                "status": 422,
                "title_ru": "Результат приоритетов программы недопустим",
            }
        )
    write(path, registry)
