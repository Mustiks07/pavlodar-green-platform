"""Add authorized short-lived downloads for immutable export artifacts."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERSION = "1.11.0"
PATH = "/v1/exports/{export_id}/download"


def read(name):
    path = ROOT / name
    return path, json.loads(path.read_text(encoding="utf-8"))


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


domain_path, domain = read("contracts/domain.schema.json")
if domain["$id"].rsplit("/", 1)[-1] not in {"1.10.0", VERSION}:
    raise RuntimeError("contract 1.10.0 is required")
domain["$id"] = f"https://team-vtiposhnik.example/schemas/domain/{VERSION}"
write(domain_path, domain)

api_path, api = read("contracts/openapi.json")
api["info"]["version"] = VERSION
api["info"]["description"] = (
    "Canonical API contract 1.11.0. PDF/XLSX exports are immutable snapshot-bound "
    "artifacts delivered through authorized short-lived signed downloads."
)
problem = {
    "description": (
        "Structured API error; includes 401/403/404/409/412/422/429/503 as applicable."
    ),
    "content": {
        "application/problem+json": {
            "schema": {"$ref": "#/components/schemas/Problem"}
        }
    },
}
api["paths"][PATH] = {
    "get": {
        "operationId": "downloadExport",
        "summary": "downloadExport",
        "description": (
            "Authorized same-origin download. The short-lived token is bound to the immutable "
            "artifact; session and target access are rechecked."
        ),
        "x-required-role": "viewer",
        "parameters": [
            {
                "name": "export_id",
                "in": "path",
                "required": True,
                "schema": {"type": "string", "format": "uuid"},
            },
            {
                "name": "token",
                "in": "query",
                "required": True,
                "schema": {"type": "string", "minLength": 32, "maxLength": 512},
            },
        ],
        "responses": {
            "200": {
                "description": "Immutable PDF or XLSX bytes.",
                "content": {
                    "application/octet-stream": {
                        "schema": {"type": "string", "format": "binary"}
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
    "operation_id": "downloadExport",
    "method": "GET",
    "path": PATH,
    "minimum_role": "viewer",
    "request_schema": None,
    "response_schema": None,
    "success_status": 200,
}
operations = [item for item in operations if item["operation_id"] != entry["operation_id"]]
index = next(i + 1 for i, item in enumerate(operations) if item["operation_id"] == "getExport")
operations.insert(index, entry)
write(operations_path, operations)

problem_codes_path, problem_codes = read("contracts/problem_codes.json")
new_codes = [
    {
        "code": "export_artifact_corrupt",
        "status": 503,
        "title_ru": "Файл отчёта повреждён",
    },
    {
        "code": "export_artifact_too_large",
        "status": 503,
        "title_ru": "Файл отчёта превышает допустимый размер",
    },
    {
        "code": "export_download_expired",
        "status": 410,
        "title_ru": "Ссылка на отчёт истекла",
    },
    {
        "code": "export_download_invalid",
        "status": 403,
        "title_ru": "Ссылка на отчёт недействительна",
    },
    {
        "code": "export_generation_failed",
        "status": 503,
        "title_ru": "Не удалось сформировать отчёт",
    },
    {
        "code": "export_target_invalid",
        "status": 422,
        "title_ru": "Цель отчёта недоступна для экспорта",
    },
]
known = {item["code"] for item in problem_codes["codes"]}
problem_codes["codes"].extend(item for item in new_codes if item["code"] not in known)
problem_codes["codes"].sort(key=lambda item: item["code"])
problem_codes["version"] = VERSION
write(problem_codes_path, problem_codes)

for name in ("contracts/units.json", "contracts/metric_keys.json"):
    path, registry = read(name)
    registry["version"] = VERSION
    write(path, registry)
