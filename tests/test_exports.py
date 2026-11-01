import hashlib
import io
import zipfile
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from pypdf import PdfReader
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from packages.domain.contracts import validate
from packages.domain.errors import DomainError
from services.api.config import settings
from services.api.db import engine
from services.api.exports import (
    PDF_TYPE,
    XLSX_TYPE,
    _token,
    render_pdf,
    render_xlsx,
    validate_download_token,
)
from services.worker.main import run_job
from tests.test_calculations import setup_revision
from tests.test_foundation import mutation
from tests.test_program_optimization_api import add_priority_and_calculations
from tests.test_programs import program_body

pytestmark = pytest.mark.integration


def sample_context():
    snapshot_id = "00000000-0000-4000-8000-000000000101"
    revision_id = "00000000-0000-4000-8000-000000000102"
    placement_id = "00000000-0000-4000-8000-000000000103"
    plant_id = "00000000-0000-4000-8000-000000000104"
    return {
        "target_kind": "calculation",
        "target_id": snapshot_id,
        "city": {"name": "Павлодар — СИНТЕТИЧЕСКИЙ ТЕСТ"},
        "author": "SYNTHETIC TEST specialist",
        "created_at": "2026-10-31T10:00:00Z",
        "program": None,
        "sources": [
            {
                "dataset_version_id": "00000000-0000-4000-8000-000000000105",
                "source_record_id": "row-1",
                "name": "SYNTHETIC TEST rates",
                "owner": "Test",
                "license": "Test-only",
                "source_uri": None,
                "method": "synthetic_fixture",
                "observed_at": "2026-10-30T00:00:00Z",
                "synthetic": True,
            }
        ],
        "scenarios": [
            {
                "scenario": {"name": "SYNTHETIC TEST вариант"},
                "zone": {
                    "name": "SYNTHETIC TEST участок",
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [
                            [[76.9, 52.2], [77.0, 52.2], [77.0, 52.3], [76.9, 52.2]]
                        ],
                    },
                },
                "revision": {
                    "id": revision_id,
                    "zone_version_id": "00000000-0000-4000-8000-000000000106",
                    "placements": [
                        {
                            "id": placement_id,
                            "plant_id": plant_id,
                            "quantity": 3,
                            "planting_date": "2027-05-15",
                            "position": {"type": "Point", "coordinates": [76.95, 52.23]},
                        }
                    ],
                },
                "snapshot": {
                    "id": snapshot_id,
                    "scenario_revision_id": revision_id,
                    "status": "partial",
                    "synthetic_inputs": True,
                    "cost": {
                        "known_subtotal": "30.03",
                        "lines": [
                            {
                                "id": "00000000-0000-4000-8000-000000000107",
                                "category": "material",
                                "description": "=2+2 опасный текст",
                                "quantity": 3,
                                "unit": "piece",
                                "unit_price": "10.01",
                                "subtotal": "30.03",
                                "year": 0,
                                "rate_version_id": "00000000-0000-4000-8000-000000000108",
                                "formula": "=3*10.01",
                            }
                        ],
                        "data_gaps": [],
                    },
                    "care": [],
                    "survival": [
                        {
                            "placement_id": placement_id,
                            "model_kind": "expert_rules",
                            "calibration_status": "uncalibrated",
                            "points": [
                                {"year": 1, "probability": 0.8, "lower": 0.6, "upper": 0.9},
                                {"year": 2, "probability": 0.7, "lower": 0.5, "upper": 0.85},
                                {"year": 3, "probability": 0.6, "lower": 0.4, "upper": 0.8},
                            ],
                        }
                    ],
                    "ecosystem": [],
                    "warnings": [
                        {
                            "code": "synthetic_fixture",
                            "message": "Только тестовые входы",
                            "blocking": False,
                        }
                    ],
                },
            }
        ],
    }


def test_pdf_embeds_cyrillic_font_and_keeps_snapshot_values():
    data = render_pdf(sample_context())
    assert data.startswith(b"%PDF") and b"/FontFile2" in data
    reader = PdfReader(io.BytesIO(data))
    text_value = "\n".join(page.extract_text() for page in reader.pages)
    assert "Павлодар" in text_value
    assert "30.03" in text_value
    assert "00000000-0000-4000-8000-000000000101" in text_value


def test_xlsx_has_required_sheets_typed_numbers_and_no_formulas():
    data = render_xlsx(sample_context())
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        workbook = archive.read("xl/workbook.xml").decode()
        names = (
            "summary",
            "quantities",
            "rates",
            "costs",
            "care",
            "survival",
            "ecosystem",
            "sources",
        )
        positions = []
        for name in names:
            assert f'name="{name}"' in workbook
            positions.append(workbook.index(f'name="{name}"'))
        assert positions == sorted(positions)
        sheets = [
            archive.read(name).decode()
            for name in archive.namelist()
            if name.startswith("xl/worksheets/sheet") and name.endswith(".xml")
        ]
        assert all("<f" not in value for value in sheets)
        shared = archive.read("xl/sharedStrings.xml").decode()
        assert "'=2+2 опасный текст" in shared
        assert "'=3*10.01" in shared
        assert "30.03" not in shared  # money stays numeric, never a display string


def test_download_token_rejects_tampering_and_expiry():
    artifact_id = str(uuid4())
    valid = _token(artifact_id, datetime.now(UTC) + timedelta(minutes=1))
    validate_download_token(artifact_id, valid)
    with pytest.raises(DomainError) as tampered:
        validate_download_token(artifact_id, valid[:-1] + ("A" if valid[-1] != "A" else "B"))
    assert tampered.value.code == "export_download_invalid"
    expired = _token(artifact_id, datetime.now(UTC) - timedelta(minutes=1))
    with pytest.raises(DomainError) as old:
        validate_download_token(artifact_id, expired)
    assert old.value.code == "export_download_expired"


@pytest.mark.parametrize(("format_name", "magic"), [("pdf", b"%PDF"), ("xlsx", b"PK")])
def test_snapshot_export_job_download_and_idor(clients, tmp_path, monkeypatch, format_name, magic):
    monkeypatch.setattr(settings(), "export_root", str(tmp_path))
    _, _, saved, _ = setup_revision(clients, with_model=True)
    calculation = mutation(
        clients["specialist"],
        "POST",
        "/v1/calculations/fast",
        {
            "scenario_revision_id": saved.json()["id"],
            "mode": "fast",
            "include_modules": ["cost", "survival"],
            "seed": 17,
        },
    )
    assert calculation.status_code == 200, calculation.text
    snapshot = calculation.json()["snapshot"]
    key = str(uuid4())
    body = {
        "target_kind": "calculation",
        "target_id": snapshot["id"],
        "format": format_name,
        "language": "ru",
    }
    started = mutation(clients["specialist"], "POST", "/v1/exports", body, key=key)
    assert started.status_code == 202, started.text
    repeated = mutation(clients["specialist"], "POST", "/v1/exports", body, key=key)
    assert repeated.json() == started.json()
    run_job.run(started.json()["id"])
    job = clients["specialist"].get(f"/v1/jobs/{started.json()['id']}")
    assert job.status_code == 200 and job.json()["state"] == "succeeded", job.text
    export_id = job.json()["result_ref_id"]
    metadata = clients["specialist"].get(f"/v1/exports/{export_id}")
    assert metadata.status_code == 200, metadata.text
    assert metadata.json()["target_id"] == snapshot["id"]
    assert clients["outsider"].get(f"/v1/exports/{export_id}").status_code == 404
    validate("ExportArtifact", metadata.json())
    download = clients["specialist"].get(metadata.json()["download_url"])
    assert download.status_code == 200 and download.content.startswith(magic)
    assert hashlib.sha256(download.content).hexdigest() == metadata.json()["sha256"]
    assert metadata.json()["byte_size"] == len(download.content)
    assert metadata.json()["media_type"] == download.headers["content-type"].split(";")[0]
    assert metadata.json()["media_type"] == (PDF_TYPE if format_name == "pdf" else XLSX_TYPE)
    assert clients["outsider"].get(metadata.json()["download_url"]).status_code == 404
    invalid = clients["specialist"].get(
        f"/v1/exports/{export_id}/download", params={"token": "x" * 40}
    )
    assert invalid.status_code == 403 and invalid.json()["code"] == "export_download_invalid"

    with pytest.raises(DBAPIError), engine().begin() as connection:
        connection.execute(
            text("UPDATE export_artifacts SET sha256=sha256 WHERE id=:id"), {"id": export_id}
        )

    # Stored size and digest are rechecked against the real file on every download.
    with engine().begin() as connection:
        storage_key = connection.execute(
            text("SELECT storage_key FROM export_artifacts WHERE id=:id"), {"id": export_id}
        ).scalar_one()
    stored = tmp_path / storage_key
    original = stored.read_bytes()
    stored.write_bytes(original + b"x")
    resized = clients["specialist"].get(metadata.json()["download_url"])
    assert resized.status_code == 503 and resized.json()["code"] == "export_artifact_corrupt"
    stored.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
    altered = clients["specialist"].get(metadata.json()["download_url"])
    assert altered.status_code == 503 and altered.json()["code"] == "export_artifact_corrupt"


def test_export_rejects_unknown_target(clients):
    response = mutation(
        clients["specialist"],
        "POST",
        "/v1/exports",
        {
            "target_kind": "calculation",
            "target_id": str(uuid4()),
            "format": "pdf",
            "language": "ru",
        },
    )
    assert response.status_code == 404


def test_program_export_contains_only_selected_scenarios(clients, tmp_path, monkeypatch):
    monkeypatch.setattr(settings(), "export_root", str(tmp_path))
    body = program_body(clients)
    body["priority_result_id"] = add_priority_and_calculations(body)
    body["benefit_weights"] = [{"factor": "green_deficit", "weight": 1.0}]
    body["capital_budget"] = "100.00"
    created = mutation(clients["specialist"], "POST", "/v1/programs", body)
    queued = mutation(
        clients["specialist"],
        "POST",
        f"/v1/programs/{created.json()['id']}/optimize",
        {"program_id": created.json()["id"], "time_limit_seconds": 5, "seed": 11},
        etag=created.headers["etag"],
    )
    run_job.run(queued.json()["id"])
    optimization = clients["specialist"].get(f"/v1/jobs/{queued.json()['id']}").json()
    program_revision = clients["specialist"].get(
        f"/v1/program-revisions/{optimization['result_ref_id']}"
    ).json()
    selected = program_revision["selected_scenario_revision_ids"]
    assert len(selected) == 1

    started = mutation(
        clients["specialist"],
        "POST",
        "/v1/exports",
        {
            "target_kind": "program_revision",
            "target_id": program_revision["id"],
            "format": "xlsx",
            "language": "ru",
        },
    )
    assert started.status_code == 202, started.text
    run_job.run(started.json()["id"])
    export_job = clients["specialist"].get(f"/v1/jobs/{started.json()['id']}").json()
    assert export_job["state"] == "succeeded"
    metadata = clients["specialist"].get(
        f"/v1/exports/{export_job['result_ref_id']}"
    ).json()
    workbook = clients["specialist"].get(metadata["download_url"]).content
    with zipfile.ZipFile(io.BytesIO(workbook)) as archive:
        shared = archive.read("xl/sharedStrings.xml").decode()
    assert selected[0] in shared
    assert next(value for value in body["candidate_revision_ids"] if value not in selected) not in shared
