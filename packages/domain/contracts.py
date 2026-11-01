import json
from functools import lru_cache
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[2]
DOMAIN = json.loads((ROOT / "contracts/domain.schema.json").read_text(encoding="utf-8"))
OPENAPI = json.loads((ROOT / "contracts/openapi.json").read_text(encoding="utf-8"))
OPERATIONS = json.loads((ROOT / "contracts/operations.json").read_text(encoding="utf-8"))


@lru_cache
def validator(name):
    return Draft202012Validator(
        {"$defs": DOMAIN["$defs"], "$ref": f"#/$defs/{name}"}, format_checker=FormatChecker()
    )


def validate(name, value):
    validator(name).validate(value)
    # Pydantic provides generated typed DTOs; JSON Schema above remains authoritative
    # for conditionals which generators do not necessarily preserve.
    from packages.domain import generated

    return getattr(generated, name).model_validate(value)
