"""Restore a local Compose backup into a new database; never overwrite an existing database."""

import hashlib
import io
import json
import subprocess
import tarfile
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from sqlalchemy import create_engine, text

from services.api.config import settings
from services.api.db import engine

ROOT = Path(__file__).resolve().parents[2]
TABLES = [
    "cities",
    "principals",
    "city_grants",
    "datasets",
    "dataset_grants",
    "dataset_versions",
    "uploads",
    "import_records",
    "import_quality",
    "map_layers",
    "map_archive_artifacts",
    "address_entries",
    "plant_identities",
    "catalog_versions",
    "catalog_state",
    "plant_versions",
    "rule_versions",
    "stock_item_versions",
    "survival_model_versions",
    "rate_identities",
    "rate_versions",
    "calculation_snapshots",
    "priority_results",
    "zones",
    "zone_versions",
    "scenarios",
    "scenario_revisions",
    "programs",
    "program_input_versions",
    "program_input_candidates",
    "program_revisions",
    "program_revision_calculations",
    "export_artifacts",
    "chat_sessions",
    "chat_messages",
    "proposals",
    "revision_datasets",
    "idempotency",
    "audit_events",
    "jobs",
    "outbox",
    "job_events",
    "spatial_results",
    "research_receipts",
    "research_files",
    "research_quality",
    "staging_identities",
    "staging_records",
    "staging_occurrences",
]


def backup_volume(container, root):
    script = """
import sys, tarfile
from pathlib import Path
root = Path(sys.argv[1]).resolve()
with tarfile.open(fileobj=sys.stdout.buffer, mode='w|gz') as archive:
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root)
        if (path.is_file() and '.synthetic-trash' not in relative.parts
                and not path.name.endswith('.part')):
            archive.add(path, arcname=relative.as_posix(), recursive=False)
"""
    return subprocess.run(
        [
            "docker",
            "exec",
            container,
            "/app/.venv/bin/python",
            "-c",
            script,
            root,
        ],
        capture_output=True,
        check=True,
    ).stdout


def restore_volume(archive_bytes, destination):
    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as archive:
        archive.extractall(destination, filter="data")


def verify_file(root, storage_key, expected_sha, expected_size):
    root = root.resolve()
    path = (root / storage_key).resolve()
    assert root in path.parents, "Restored storage key escaped its volume"
    assert path.is_file(), f"Restored file is missing: {storage_key}"
    assert path.stat().st_size == expected_size, (
        f"Restored file size differs: {storage_key}; "
        f"expected={expected_size}, actual={path.stat().st_size}"
    )
    actual_sha = hashlib.sha256(path.read_bytes()).hexdigest()
    assert actual_sha == expected_sha, (
        f"Restored file checksum differs: {storage_key}; "
        f"expected={expected_sha}, actual={actual_sha}"
    )


def fingerprints(connection):
    return {
        name: connection.scalar(
            text(
                f"SELECT md5(coalesce(string_agg(row_to_json(t)::text, '' ORDER BY row_to_json(t)::text),'')) FROM {name} t"
            )
        )
        for name in TABLES
    }


def main():
    config = settings()
    if config.environment not in {"development", "test"} or engine().url.database != "pavlodar":
        raise SystemExit(
            "This check only supports the isolated local pavlodar development database"
        )
    started = datetime.now(UTC)
    container = "pavlodar-gpt-db-1"
    artifact_container = "pavlodar-gpt-worker-1"
    backup = subprocess.run(
        [
            "docker",
            "exec",
            container,
            "pg_dump",
            "-U",
            "pavlodar",
            "-d",
            "pavlodar",
            "-Fc",
            "--no-owner",
            "--exclude-table-data=web_sessions",
            "--exclude-table-data=login_states",
        ],
        capture_output=True,
        check=True,
    ).stdout
    upload_backup = backup_volume(artifact_container, "/var/lib/pavlodar/uploads")
    tile_backup = backup_volume(artifact_container, "/var/lib/pavlodar/tiles")
    export_backup = backup_volume(artifact_container, "/var/lib/pavlodar/exports")
    target = "pavlodar_restore_" + uuid4().hex[:12]
    with engine().connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        conn.execute(text(f'CREATE DATABASE "{target}"'))
    subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            container,
            "pg_restore",
            "-U",
            "pavlodar",
            "-d",
            target,
            "--no-owner",
            "--exit-on-error",
        ],
        input=backup,
        capture_output=True,
        check=True,
    )
    restored = create_engine(engine().url.set(database=target))
    with engine().connect() as source, restored.connect() as dest:
        expected, actual = fingerprints(source), fingerprints(dest)
        assert expected == actual, "Restored data fingerprints differ"
        assert dest.scalar(text("SELECT count(*) FROM web_sessions")) == 0
        assert (
            dest.scalar(text("SELECT version_num FROM alembic_version"))
            == "0032_problem_decisions"
        )
        expected_uploads = list(
            dest.execute(
                text(
                    "SELECT storage_key || '.bin' AS storage_key, sha256, byte_size FROM uploads "
                    "WHERE state IN ('stored','consumed') ORDER BY storage_key"
                )
            ).mappings()
        )
        expected_tiles = list(
            dest.execute(
                text(
                    "SELECT storage_key, sha256, byte_size "
                    "FROM map_archive_artifacts ORDER BY storage_key"
                )
            ).mappings()
        )
        expected_exports = list(
            dest.execute(
                text(
                    "SELECT storage_key, sha256, byte_size "
                    "FROM export_artifacts ORDER BY storage_key"
                )
            ).mappings()
        )
    restored.dispose()
    (ROOT / ".local/foundation-backup.dump").write_bytes(backup)
    (ROOT / ".local/foundation-uploads.tar.gz").write_bytes(upload_backup)
    (ROOT / ".local/foundation-tiles.tar.gz").write_bytes(tile_backup)
    (ROOT / ".local/foundation-exports.tar.gz").write_bytes(export_backup)
    with tempfile.TemporaryDirectory(prefix="restore-volumes-", dir=ROOT / ".local") as temporary:
        restored_uploads = Path(temporary) / "uploads"
        restored_tiles = Path(temporary) / "tiles"
        restored_exports = Path(temporary) / "exports"
        restored_uploads.mkdir()
        restored_tiles.mkdir()
        restored_exports.mkdir()
        restore_volume(upload_backup, restored_uploads)
        restore_volume(tile_backup, restored_tiles)
        restore_volume(export_backup, restored_exports)
        for row in expected_uploads:
            verify_file(restored_uploads, row["storage_key"], row["sha256"], row["byte_size"])
        for row in expected_tiles:
            verify_file(restored_tiles, row["storage_key"], row["sha256"], row["byte_size"])
        for row in expected_exports:
            verify_file(restored_exports, row["storage_key"], row["sha256"], row["byte_size"])
    result = {
        "passed": True,
        "scope": "Local database plus upload/tile/export volume backup/restore with checksum verification; production WAL/PITR, remote object-store versioning and cross-host recovery remain WP-11",
        "restored_database": target,
        "tables_compared": TABLES,
        "fingerprints": actual,
        "sessions_restored": False,
        "upload_bytes_restored": True,
        "tile_bytes_restored": True,
        "export_bytes_restored": True,
        "upload_files_verified": len(expected_uploads),
        "tile_files_verified": len(expected_tiles),
        "export_files_verified": len(expected_exports),
        "backup_sha256": hashlib.sha256(backup).hexdigest(),
        "upload_backup_sha256": hashlib.sha256(upload_backup).hexdigest(),
        "tile_backup_sha256": hashlib.sha256(tile_backup).hexdigest(),
        "export_backup_sha256": hashlib.sha256(export_backup).hexdigest(),
        "elapsed_seconds": (datetime.now(UTC) - started).total_seconds(),
    }
    (ROOT / "docs/evidence/foundation_restore.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
