"""Plan and explicitly execute deletion of narrowly labelled shared-development fixtures.

The default operation is read-only. Execution requires an exact saved plan, its full SHA-256,
an automatic PostgreSQL backup and a second database-scope comparison. Organizer/open data never
match the allowlist below.
"""

import argparse
import hashlib
import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import text

from services.api.config import settings
from services.api.db import engine, session

ROOT = Path(__file__).resolve().parents[2]
TARGET_SQL = text(
    """
    SELECT id::text, payload->>'name' AS name, payload->>'owner' AS owner
    FROM datasets
    WHERE
      (payload->>'name' LIKE 'SYNTHETIC TEST %'
       AND payload->>'owner'='SYNTHETIC integration test')
      OR (payload->>'name' LIKE 'SYNTHETIC LIVE %'
          AND payload->>'owner'='Integration smoke')
      OR (payload->>'name'='SYNTHETIC TEST source registry'
          AND payload->>'owner'='Synthetic integration test')
    ORDER BY id
    """
)
BLOCKER_TABLES = {
    "address_entries": "dataset_version_id",
    "rate_versions": "dataset_version_id",
    "research_quality": "version_id",
    "revision_datasets": "version_id",
    "rule_versions": "dataset_version_id",
    "staging_occurrences": "version_id",
    "stock_item_versions": "dataset_version_id",
    "survival_model_versions": "dataset_version_id",
}
TEST_SPECIALIST_ID = "00000000-0000-4000-8000-000000000002"
ZONE_TARGET_SQL = text(
    """
    SELECT z.id::text, z.city_id::text, current.payload->>'name' AS name
    FROM zones z
    JOIN zone_versions current ON current.id=z.current_version_id
    WHERE (current.payload->>'name' LIKE 'SYNTHETIC TEST %'
           OR current.payload->>'name'='SYNTHETIC zone')
      AND EXISTS (
        SELECT 1 FROM scenarios s
        WHERE s.zone_id=z.id AND s.owner_id=CAST(:owner_id AS uuid)
          AND (s.payload->>'name' LIKE 'SYNTHETIC TEST %'
               OR s.payload->>'name' IN ('SYNTHETIC scenario','SYNTHETIC OIDC integration'))
      )
      AND NOT EXISTS (
        SELECT 1 FROM zone_versions zv
        WHERE zv.zone_id=z.id
          AND NOT (zv.payload->>'name' LIKE 'SYNTHETIC TEST %'
                   OR zv.payload->>'name'='SYNTHETIC zone')
      )
      AND NOT EXISTS (
        SELECT 1 FROM scenarios s
        WHERE s.zone_id=z.id
          AND (s.owner_id<>CAST(:owner_id AS uuid)
               OR NOT (s.payload->>'name' LIKE 'SYNTHETIC TEST %'
                       OR s.payload->>'name' IN ('SYNTHETIC scenario','SYNTHETIC OIDC integration')))
      )
    ORDER BY z.id
    """
)
IMMUTABLE_TRIGGERS = {
    "map_archive_artifacts": "map_archive_artifact_immutable",
    "map_layers": "map_layer_immutable",
    "import_quality": "import_quality_immutable",
    "import_records": "import_record_immutable",
    "dataset_versions": "dataset_version_immutable",
    "uploads": "upload_immutable_after_consumed",
    "calculation_snapshots": "calculation_snapshot_immutable",
    "export_artifacts": "export_artifact_immutable",
    "priority_results": "priority_result_immutable",
    "job_events": "job_event_append_only",
    "scenario_revisions": "scenario_revision_immutable",
    "spatial_results": "spatial_results_immutable",
    "zone_versions": "zone_version_immutable",
}


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def scope_hash(scope):
    return hashlib.sha256(canonical(scope).encode()).hexdigest()


def _ids(db, statement, parameters=None):
    return sorted(str(value) for value in db.scalars(statement, parameters or {}))


def build_scope(db):
    zones = [
        dict(row)
        for row in db.execute(ZONE_TARGET_SQL, {"owner_id": TEST_SPECIALIST_ID}).mappings()
    ]
    zone_ids = [item["id"] for item in zones]
    zone_versions = (
        _ids(
            db,
            text("SELECT id::text FROM zone_versions WHERE zone_id = ANY(:ids)"),
            {"ids": zone_ids},
        )
        if zone_ids
        else []
    )
    scenario_ids = (
        _ids(
            db,
            text("SELECT id::text FROM scenarios WHERE zone_id = ANY(:ids)"),
            {"ids": zone_ids},
        )
        if zone_ids
        else []
    )
    revision_ids = (
        _ids(
            db,
            text("SELECT id::text FROM scenario_revisions WHERE scenario_id = ANY(:ids)"),
            {"ids": scenario_ids},
        )
        if scenario_ids
        else []
    )
    chat_session_ids = (
        _ids(
            db,
            text(
                "SELECT id::text FROM chat_sessions WHERE zone_id = ANY(:zone_ids) "
                "OR scenario_revision_id = ANY(:revision_ids)"
            ),
            {"zone_ids": zone_ids or [None], "revision_ids": revision_ids or [None]},
        )
        if zone_ids or revision_ids
        else []
    )
    calculation_ids = (
        _ids(
            db,
            text(
                "SELECT id::text FROM calculation_snapshots "
                "WHERE scenario_revision_id = ANY(:ids)"
            ),
            {"ids": revision_ids},
        )
        if revision_ids
        else []
    )
    job_ids = (
        _ids(
            db,
            text(
                "SELECT id::text FROM jobs WHERE input_revision_id = ANY(:revision_ids) "
                "OR (input_kind='calculation' AND input_ref_id = ANY(:calculation_ids)) "
                "OR (input_kind='chat_session' AND input_ref_id = ANY(:chat_session_ids))"
            ),
            {
                "revision_ids": revision_ids or [None],
                "calculation_ids": calculation_ids or [None],
                "chat_session_ids": chat_session_ids or [None],
            },
        )
        if revision_ids or chat_session_ids
        else []
    )
    datasets = [dict(row) for row in db.execute(TARGET_SQL).mappings()]
    dataset_ids = [item["id"] for item in datasets]
    if dataset_ids:
        versions = _ids(
            db,
            text("SELECT id::text FROM dataset_versions WHERE dataset_id = ANY(:ids)"),
            {"ids": dataset_ids},
        )
        uploads = list(
            db.execute(
                text(
                    "SELECT id::text, storage_key || '.bin' AS storage_key, "
                    "sha256, byte_size FROM uploads "
                    "WHERE dataset_id = ANY(:ids) ORDER BY id"
                ),
                {"ids": dataset_ids},
            ).mappings()
        )
    else:
        versions, uploads = [], []
    blockers = {}
    for table, column in BLOCKER_TABLES.items():
        if not versions:
            blockers[table] = 0
        elif table == "revision_datasets":
            blockers[table] = int(
                db.scalar(
                    text(
                        "SELECT count(*) FROM revision_datasets "
                        "WHERE version_id = ANY(:ids) "
                        "AND NOT (revision_id = ANY(:revision_ids))"
                    ),
                    {"ids": versions, "revision_ids": revision_ids or [None]},
                )
            )
        else:
            blockers[table] = int(
                db.scalar(
                    text(f"SELECT count(*) FROM {table} WHERE {column} = ANY(:ids)"),
                    {"ids": versions},
                )
            )
    blockers["external_zone_version_revisions"] = (
        int(
            db.scalar(
                text(
                    "SELECT count(*) FROM scenario_revisions "
                    "WHERE zone_version_id = ANY(:zone_versions) "
                    "AND NOT (scenario_id = ANY(:scenario_ids))"
                ),
                {
                    "zone_versions": zone_versions,
                    "scenario_ids": scenario_ids or [None],
                },
            )
        )
        if zone_versions
        else 0
    )
    blockers["active_jobs"] = (
        int(
            db.scalar(
                text(
                    "SELECT count(*) FROM jobs WHERE id = ANY(:ids) "
                    "AND state NOT IN ('succeeded','failed','cancelled')"
                ),
                {"ids": job_ids},
            )
        )
        if job_ids
        else 0
    )
    blockers["uploads_using_jobs"] = (
        int(
            db.scalar(
                text("SELECT count(*) FROM uploads WHERE import_job_id = ANY(:ids)"),
                {"ids": job_ids},
            )
        )
        if job_ids
        else 0
    )
    blockers["program_input_candidates"] = (
        int(
            db.scalar(
                text(
                    "SELECT count(*) FROM program_input_candidates "
                    "WHERE scenario_revision_id = ANY(:ids)"
                ),
                {"ids": revision_ids},
            )
        )
        if revision_ids
        else 0
    )
    priority_result_ids = (
        _ids(
            db,
            text(
                "SELECT DISTINCT pr.id::text FROM priority_results pr "
                "CROSS JOIN LATERAL jsonb_array_elements(pr.payload->'zones') item "
                "WHERE item->>'zone_id' = ANY(:ids)"
            ),
            {"ids": zone_ids},
        )
        if zone_ids
        else []
    )
    archives = (
        list(
            db.execute(
                text(
                    "SELECT id::text, storage_key, sha256, byte_size "
                    "FROM map_archive_artifacts "
                    "WHERE dataset_version_id = ANY(:ids) ORDER BY id"
                ),
                {"ids": versions},
            ).mappings()
        )
        if versions
        else []
    )
    exports = (
        list(
            db.execute(
                text(
                    "SELECT id::text, storage_key, sha256, byte_size "
                    "FROM export_artifacts WHERE job_id = ANY(:job_ids) "
                    "OR (target_kind='calculation' AND target_id = ANY(:calculation_ids)) "
                    "ORDER BY id"
                ),
                {
                    "job_ids": job_ids or [None],
                    "calculation_ids": calculation_ids or [None],
                },
            ).mappings()
        )
        if job_ids or calculation_ids
        else []
    )
    counts = {
        "datasets": len(dataset_ids),
        "versions": len(versions),
        "uploads": len(uploads),
        "map_layers": (
            int(
                db.scalar(
                    text("SELECT count(*) FROM map_layers WHERE dataset_id = ANY(:ids)"),
                    {"ids": dataset_ids},
                )
            )
            if dataset_ids
            else 0
        ),
        "import_records": (
            int(
                db.scalar(
                    text("SELECT count(*) FROM import_records WHERE version_id = ANY(:ids)"),
                    {"ids": versions},
                )
            )
            if versions
            else 0
        ),
    }
    return {
        "database": engine().url.database,
        "migration": db.scalar(text("SELECT version_num FROM alembic_version")),
        "allowlist": [
            "SYNTHETIC TEST % + owner=SYNTHETIC integration test",
            "SYNTHETIC LIVE % + owner=Integration smoke",
            "SYNTHETIC TEST source registry + owner=Synthetic integration test",
            "zone name=SYNTHETIC TEST % or SYNTHETIC zone + only synthetic-named scenarios owned by fixed local test specialist",
        ],
        "zones": zones,
        "zone_version_ids": zone_versions,
        "scenario_ids": scenario_ids,
        "scenario_revision_ids": revision_ids,
        "chat_session_ids": chat_session_ids,
        "job_ids": job_ids,
        "priority_result_ids": priority_result_ids,
        "datasets": datasets,
        "version_ids": versions,
        "uploads": [dict(item) for item in uploads],
        "archives": [dict(item) for item in archives],
        "exports": [dict(item) for item in exports],
        "blockers": blockers,
        "counts": counts,
        "scenario_counts": {
            "zones": len(zone_ids),
            "zone_versions": len(zone_versions),
            "scenarios": len(scenario_ids),
            "scenario_revisions": len(revision_ids),
            "chat_sessions": len(chat_session_ids),
            "chat_messages": (
                int(
                    db.scalar(
                        text("SELECT count(*) FROM chat_messages WHERE session_id = ANY(:ids)"),
                        {"ids": chat_session_ids},
                    )
                )
                if chat_session_ids
                else 0
            ),
            "proposals": (
                int(
                    db.scalar(
                        text(
                            "SELECT count(*) FROM proposals WHERE scenario_id = ANY(:scenario_ids) "
                            "OR assistant_message_id IN "
                            "(SELECT id FROM chat_messages WHERE session_id = ANY(:session_ids))"
                        ),
                        {
                            "scenario_ids": scenario_ids or [None],
                            "session_ids": chat_session_ids or [None],
                        },
                    )
                )
                if scenario_ids or chat_session_ids
                else 0
            ),
            "jobs": len(job_ids),
            "calculation_snapshots": len(calculation_ids),
            "export_artifacts": len(exports),
            "spatial_results": (
                int(
                    db.scalar(
                        text(
                            "SELECT count(*) FROM spatial_results "
                            "WHERE scenario_revision_id = ANY(:ids)"
                        ),
                        {"ids": revision_ids},
                    )
                )
                if revision_ids
                else 0
            ),
            "priority_results": len(priority_result_ids),
        },
    }


def make_plan(db):
    scope = build_scope(db)
    return {
        "format": "pavlodar-synthetic-cleanup-plan-v3",
        "created_at": datetime.now(UTC).isoformat(),
        "scope_sha256": scope_hash(scope),
        "scope": scope,
        "executable": bool(scope["datasets"] or scope["zones"])
        and not any(scope["blockers"].values()),
    }


def validate_environment():
    config = settings()
    if config.environment not in {"development", "test"}:
        raise SystemExit("Synthetic cleanup is disabled outside development/test")
    url = engine().url
    if url.database not in {"pavlodar", "pavlodar_test"} or url.host not in {
        "127.0.0.1",
        "localhost",
    }:
        raise SystemExit("Synthetic cleanup only accepts an explicit local development database")


def backup_database(scope_sha):
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    output_dir = ROOT / ".local" / "cleanup-backups"
    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir / f"synthetic-{stamp}-{scope_sha[:12]}.dump"
    result = subprocess.run(
        [
            "docker",
            "exec",
            "pavlodar-gpt-db-1",
            "pg_dump",
            "-U",
            "pavlodar",
            "-d",
            engine().url.database,
            "-Fc",
            "--no-owner",
        ],
        capture_output=True,
        check=True,
    )
    if not result.stdout:
        raise RuntimeError("Backup is empty")
    destination.write_bytes(result.stdout)
    return {
        "path": str(destination),
        "sha256": hashlib.sha256(result.stdout).hexdigest(),
        "byte_size": len(result.stdout),
    }


def delete_scope(db, scope):
    dataset_ids = [item["id"] for item in scope["datasets"]]
    version_ids = scope["version_ids"]
    for table, trigger in IMMUTABLE_TRIGGERS.items():
        db.execute(text(f"ALTER TABLE {table} DISABLE TRIGGER {trigger}"))
    revision_ids = scope["scenario_revision_ids"]
    chat_session_ids = scope["chat_session_ids"]
    job_ids = scope["job_ids"]
    if scope["priority_result_ids"]:
        db.execute(
            text("DELETE FROM priority_results WHERE id = ANY(:ids)"),
            {"ids": scope["priority_result_ids"]},
        )
    if revision_ids:
        if scope["exports"]:
            db.execute(
                text("DELETE FROM export_artifacts WHERE id = ANY(:ids)"),
                {"ids": [item["id"] for item in scope["exports"]]},
            )
        db.execute(
            text("DELETE FROM spatial_results WHERE scenario_revision_id = ANY(:ids)"),
            {"ids": revision_ids},
        )
        db.execute(
            text("DELETE FROM calculation_snapshots WHERE scenario_revision_id = ANY(:ids)"),
            {"ids": revision_ids},
        )
        db.execute(
            text("DELETE FROM revision_datasets WHERE revision_id = ANY(:ids)"),
            {"ids": revision_ids},
        )
    if chat_session_ids:
        db.execute(
            text("UPDATE chat_messages SET proposal_id=NULL WHERE session_id = ANY(:ids)"),
            {"ids": chat_session_ids},
        )
        db.execute(
            text(
                "DELETE FROM proposals WHERE scenario_id = ANY(:scenario_ids) "
                "OR assistant_message_id IN "
                "(SELECT id FROM chat_messages WHERE session_id = ANY(:session_ids))"
            ),
            {
                "scenario_ids": scope["scenario_ids"] or [None],
                "session_ids": chat_session_ids,
            },
        )
        db.execute(
            text("DELETE FROM chat_messages WHERE session_id = ANY(:ids)"),
            {"ids": chat_session_ids},
        )
    if job_ids:
        db.execute(text("DELETE FROM job_events WHERE job_id = ANY(:ids)"), {"ids": job_ids})
        db.execute(text("DELETE FROM outbox WHERE job_id = ANY(:ids)"), {"ids": job_ids})
        db.execute(text("DELETE FROM jobs WHERE id = ANY(:ids)"), {"ids": job_ids})
    if chat_session_ids:
        db.execute(
            text("DELETE FROM chat_sessions WHERE id = ANY(:ids)"),
            {"ids": chat_session_ids},
        )
    if revision_ids:
        db.execute(
            text(
                "UPDATE chat_messages SET proposal_id=NULL WHERE proposal_id IN "
                "(SELECT id FROM proposals WHERE scenario_id = ANY(:ids))"
            ),
            {"ids": scope["scenario_ids"]},
        )
        db.execute(
            text("DELETE FROM proposals WHERE scenario_id = ANY(:ids)"),
            {"ids": scope["scenario_ids"]},
        )
        db.execute(
            text("DELETE FROM scenario_revisions WHERE id = ANY(:ids)"),
            {"ids": revision_ids},
        )
    if scope["scenario_ids"]:
        db.execute(
            text("DELETE FROM scenarios WHERE id = ANY(:ids)"),
            {"ids": scope["scenario_ids"]},
        )
    if scope["zone_version_ids"]:
        db.execute(
            text("DELETE FROM zone_versions WHERE id = ANY(:ids)"),
            {"ids": scope["zone_version_ids"]},
        )
    deleted_zones = 0
    if scope["zones"]:
        deleted_zones = db.execute(
            text("DELETE FROM zones WHERE id = ANY(:ids)"),
            {"ids": [item["id"] for item in scope["zones"]]},
        ).rowcount
    db.execute(
        text("UPDATE datasets SET current_version_id=NULL WHERE id = ANY(:ids)"),
        {"ids": dataset_ids},
    )
    if version_ids:
        for table, column in [
            ("map_archive_artifacts", "dataset_version_id"),
            ("map_layers", "dataset_version_id"),
            ("import_quality", "version_id"),
            ("import_records", "version_id"),
        ]:
            db.execute(
                text(f"DELETE FROM {table} WHERE {column} = ANY(:ids)"),
                {"ids": version_ids},
            )
        db.execute(
            text("DELETE FROM dataset_versions WHERE id = ANY(:ids)"),
            {"ids": version_ids},
        )
    db.execute(
        text("DELETE FROM dataset_grants WHERE dataset_id = ANY(:ids)"),
        {"ids": dataset_ids},
    )
    db.execute(
        text("DELETE FROM uploads WHERE dataset_id = ANY(:ids)"),
        {"ids": dataset_ids},
    )
    deleted = db.execute(
        text("DELETE FROM datasets WHERE id = ANY(:ids)"), {"ids": dataset_ids}
    ).rowcount
    db.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    for table, trigger in reversed(IMMUTABLE_TRIGGERS.items()):
        db.execute(text(f"ALTER TABLE {table} ENABLE TRIGGER {trigger}"))
    return {"datasets": deleted, "zones": deleted_zones}


def move_artifacts(scope, scope_sha):
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    trash = (ROOT / ".local" / "synthetic-trash" / f"{stamp}-{scope_sha[:12]}").resolve()
    moved = []
    docker_volume = scope["database"] == "pavlodar"
    for kind, root_value, items in [
        ("uploads", settings().upload_root, scope["uploads"]),
        ("tiles", settings().tile_root, scope["archives"]),
        ("exports", settings().export_root, scope["exports"]),
    ]:
        root = Path(root_value).resolve()
        for item in items:
            if docker_volume:
                container_root = f"/var/lib/pavlodar/{kind}"
                destination_key = f".synthetic-trash/{stamp}-{scope_sha[:12]}/{item['storage_key']}"
                helper = (
                    "from pathlib import Path; import sys; "
                    "r=Path(sys.argv[1]).resolve(); s=(r/sys.argv[2]).resolve(); "
                    "d=(r/sys.argv[3]).resolve(); "
                    "assert r in s.parents and r in d.parents; "
                    "d.parent.mkdir(parents=True,exist_ok=True); "
                    "sys.exit(0) if not s.is_file() else s.replace(d)"
                )
                result = subprocess.run(
                    [
                        "docker",
                        "exec",
                        "pavlodar-gpt-api-1",
                        "/app/.venv/bin/python",
                        "-c",
                        helper,
                        container_root,
                        item["storage_key"],
                        destination_key,
                    ],
                    capture_output=True,
                    check=True,
                )
                moved.append(
                    {
                        "kind": kind,
                        "from": f"docker:{container_root}/{item['storage_key']}",
                        "to": f"docker:{container_root}/{destination_key}",
                        "command_output_bytes": len(result.stdout),
                    }
                )
                continue
            source = (root / item["storage_key"]).resolve()
            if root not in source.parents:
                raise RuntimeError(f"Unsafe {kind} storage key")
            if not source.is_file():
                continue
            destination = trash / kind / item["storage_key"]
            destination.parent.mkdir(parents=True, exist_ok=True)
            source.replace(destination)
            moved.append({"kind": kind, "from": str(source), "to": str(destination)})
    return moved


def command_plan(args):
    with session() as db:
        plan = make_plan(db)
    output = Path(args.output).resolve()
    if output.exists():
        raise SystemExit(f"Refusing to overwrite existing plan: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(plan, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({**plan, "plan_path": str(output)}, indent=2, ensure_ascii=False))


def command_execute(args):
    plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
    if plan.get("format") != "pavlodar-synthetic-cleanup-plan-v3":
        raise SystemExit("Unsupported cleanup plan")
    expected = plan["scope_sha256"]
    if args.confirm != expected:
        raise SystemExit("--confirm must equal the complete scope_sha256 from the saved plan")
    if not plan.get("executable"):
        raise SystemExit("Plan is empty or has blocking references")
    with session() as db:
        current = build_scope(db)
    if scope_hash(current) != expected or current != plan["scope"]:
        raise SystemExit("Database scope changed after planning; create a new plan")
    backup = backup_database(expected)
    with session() as db, db.begin():
        deleted = delete_scope(db, current)
    moved = move_artifacts(current, expected)
    print(
        json.dumps(
            {
                "deleted": deleted,
                "scope_sha256": expected,
                "backup": backup,
                "moved_artifacts": moved,
                "recoverable": True,
            },
            indent=2,
            ensure_ascii=False,
        )
    )


def main():
    validate_environment()
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(required=True)
    plan = commands.add_parser("plan")
    plan.add_argument("--output", required=True)
    plan.set_defaults(run=command_plan)
    execute = commands.add_parser("execute")
    execute.add_argument("--plan", required=True)
    execute.add_argument("--confirm", required=True)
    execute.set_defaults(run=command_execute)
    args = parser.parse_args()
    args.run(args)


if __name__ == "__main__":
    main()
