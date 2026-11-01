"""Run browser checks against a disposable database without touching shared dev data.

The OIDC test client is allowlisted for localhost:5173, so this harness keeps that web
origin, temporarily replaces only the local API on :8001, and restores the Docker API in
``finally``. PostgreSQL and Redis stay up; the isolated run uses its own database and Redis DB.
"""

import argparse
import os
import shutil
import signal
import subprocess
import tempfile
import time
from pathlib import Path

import httpx
import redis
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from services.api.config import settings

ROOT = Path(__file__).resolve().parents[2]
TARGET_DATABASE = "pavlodar_browser_test"
TEST_REDIS_URL = "redis://127.0.0.1:6381/9"
WEB_ORIGIN = "http://localhost:5173"
API_ORIGIN = "http://127.0.0.1:8001"
COMPOSE = ["docker", "compose", "--env-file", ".env", "-f", "infra/compose.yml"]


def run(command, *, env=None, check=True):
    return subprocess.run(
        command,
        cwd=ROOT,
        env=env,
        check=check,
        text=True,
        capture_output=True,
    )


def database_urls():
    source = make_url(settings().database_url.get_secret_value())
    if source.host not in {"127.0.0.1", "localhost"}:
        raise SystemExit("Browser isolation only accepts the local PostgreSQL host")
    if source.database == TARGET_DATABASE:
        raise SystemExit("Main database URL unexpectedly points at the disposable target")
    if not TARGET_DATABASE.replace("_", "").isalnum():
        raise SystemExit("Invalid fixed browser-test database name")
    return source, source.set(database=TARGET_DATABASE)


def recreate_database(source):
    admin = create_engine(source.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.execute(
            text(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname=:name AND pid<>pg_backend_pid()"
            ),
            {"name": TARGET_DATABASE},
        )
        connection.exec_driver_sql(f'DROP DATABASE IF EXISTS "{TARGET_DATABASE}"')
        connection.exec_driver_sql(f'CREATE DATABASE "{TARGET_DATABASE}"')
    admin.dispose()


def drop_database(source):
    admin = create_engine(source.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.execute(
            text(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname=:name AND pid<>pg_backend_pid()"
            ),
            {"name": TARGET_DATABASE},
        )
        connection.exec_driver_sql(f'DROP DATABASE IF EXISTS "{TARGET_DATABASE}"')
    admin.dispose()


def is_ready(url):
    try:
        return httpx.get(url, timeout=2).status_code == 200
    except httpx.HTTPError:
        return False


def wait_ready(url, processes, timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        failed = [name for name, process, _ in processes if process.poll() is not None]
        if failed:
            raise RuntimeError("Isolated process exited early: " + ", ".join(failed))
        if is_ready(url):
            return
        time.sleep(0.5)
    raise RuntimeError(f"Timed out waiting for {url}")


def start_process(name, command, env, logs):
    stream = (logs / f"{name}.log").open("wb")
    kwargs = {}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    process = subprocess.Popen(
        command,
        cwd=ROOT,
        env=env,
        stdout=stream,
        stderr=subprocess.STDOUT,
        **kwargs,
    )
    return name, process, stream


def stop_process(item):
    _, process, stream = item
    if process.poll() is None:
        if os.name == "nt":
            # CTRL_BREAK can reach the parent console despite CREATE_NEW_PROCESS_GROUP.
            # taskkill targets the exact child PID and its descendants instead.
            run(["taskkill", "/PID", str(process.pid), "/T", "/F"], check=False)
        else:
            os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            if os.name != "nt":
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=10)
    stream.close()


def docker_api_running():
    result = run([*COMPOSE, "ps", "-q", "api"], check=False)
    if not result.stdout.strip():
        return False
    inspected = run(
        ["docker", "inspect", "-f", "{{.State.Running}}", result.stdout.strip()], check=False
    )
    return inspected.returncode == 0 and inspected.stdout.strip() == "true"


def isolated_environment(target_url, upload_root, tile_root, export_root):
    env = os.environ.copy()
    env.update(
        {
            "PAVLODAR_DATABASE_URL": target_url.render_as_string(hide_password=False),
            "PAVLODAR_REDIS_URL": TEST_REDIS_URL,
            "PAVLODAR_ENVIRONMENT": "test",
            "PAVLODAR_PUBLIC_ORIGIN": WEB_ORIGIN,
            "PAVLODAR_COOKIE_SECURE": "false",
            "PAVLODAR_OIDC_INTERNAL_ORIGIN": "",
            "PAVLODAR_UPLOAD_ROOT": str(upload_root),
            "PAVLODAR_TILE_ROOT": str(tile_root),
            "PAVLODAR_EXPORT_ROOT": str(export_root),
            "PG_API_ORIGIN": API_ORIGIN,
            "PG_WEB_URL": WEB_ORIGIN,
            "PYTHONUNBUFFERED": "1",
        }
    )
    env.setdefault("PG_TEST_CREDENTIALS", str(ROOT / ".local/test-credentials.json"))
    return env


def cleanup_stale_artifacts(local_root):
    for candidate in [
        *local_root.glob("browser-check-uploads-*"),
        *local_root.glob("browser-check-tiles-*"),
        *local_root.glob("browser-check-exports-*"),
    ]:
        resolved = candidate.resolve()
        if resolved.parent != local_root or not resolved.is_dir():
            raise RuntimeError(f"Unsafe stale upload path: {resolved}")
        shutil.rmtree(resolved)


def main():
    parser = argparse.ArgumentParser(
        description="Run one browser command against a disposable PostGIS database"
    )
    parser.add_argument("--cwd", default=".", help="command directory inside the repository")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("provide a command after --")
    command_cwd = (ROOT / args.cwd).resolve()
    if command_cwd != ROOT and ROOT not in command_cwd.parents:
        parser.error("--cwd must stay inside the repository")
    if not command_cwd.is_dir():
        parser.error("--cwd must name an existing directory")

    source_url, target_url = database_urls()
    local_root = (ROOT / ".local").resolve()
    local_root.mkdir(exist_ok=True)
    cleanup_stale_artifacts(local_root)
    upload_root = Path(
        tempfile.mkdtemp(prefix="browser-check-uploads-", dir=local_root)
    ).resolve()
    tile_root = Path(tempfile.mkdtemp(prefix="browser-check-tiles-", dir=local_root)).resolve()
    export_root = Path(tempfile.mkdtemp(prefix="browser-check-exports-", dir=local_root)).resolve()
    if upload_root.parent != local_root or tile_root.parent != local_root or export_root.parent != local_root:
        raise SystemExit("Disposable artifact directory escaped .local")
    logs = local_root / "browser-check-logs"
    logs.mkdir(exist_ok=True)
    env = isolated_environment(target_url, upload_root, tile_root, export_root)
    processes = []
    restore_api = False
    exit_code = 1
    try:
        recreate_database(source_url)
        redis.Redis.from_url(TEST_REDIS_URL).flushdb()
        run(["uv", "run", "alembic", "upgrade", "head"], env=env)
        run(["uv", "run", "python", "-m", "tools.dev.seed", "--profile", "test"], env=env)

        restore_api = docker_api_running()
        if restore_api:
            run([*COMPOSE, "stop", "api"])

        processes.append(
            start_process(
                "worker",
                [
                    "uv",
                    "run",
                    "celery",
                    "-A",
                    "services.worker.main:celery",
                    "worker",
                    "-Q",
                    "import,analysis,export,physical",
                    "--pool=solo",
                    "--concurrency=1",
                    "--loglevel=warning",
                ],
                env,
                logs,
            )
        )
        processes.append(
            start_process(
                "dispatcher",
                ["uv", "run", "python", "-m", "services.worker.main"],
                env,
                logs,
            )
        )
        processes.append(
            start_process(
                "api",
                [
                    "uv",
                    "run",
                    "uvicorn",
                    "services.api.main:app",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    "8001",
                    "--workers",
                    "4",
                    "--no-access-log",
                ],
                env,
                logs,
            )
        )
        wait_ready(API_ORIGIN + "/health/ready", processes)
        if not is_ready(WEB_ORIGIN):
            npm = "npm.cmd" if os.name == "nt" else "npm"
            processes.append(
                start_process(
                    "web",
                    [
                        npm,
                        "--prefix",
                        "apps/web",
                        "run",
                        "dev",
                        "--",
                        "--host",
                        "127.0.0.1",
                    ],
                    env,
                    logs,
                )
            )
            wait_ready(WEB_ORIGIN, processes)

        print(
            f"Disposable browser environment ready: {TARGET_DATABASE}; running command",
            flush=True,
        )
        completed = subprocess.run(command, cwd=command_cwd, env=env, check=False)
        exit_code = completed.returncode
    finally:
        cleanup_failures = []
        for item in reversed(processes):
            try:
                stop_process(item)
            except Exception:  # noqa: BLE001 - cleanup continues for every isolated resource
                cleanup_failures.append(f"process:{item[0]}")
        try:
            redis.Redis.from_url(TEST_REDIS_URL).flushdb()
        except Exception:  # noqa: BLE001 - cleanup continues to database and API restore
            cleanup_failures.append("redis:9")
        try:
            drop_database(source_url)
        except Exception:  # noqa: BLE001 - API restore must still run
            cleanup_failures.append(f"database:{TARGET_DATABASE}")
        try:
            if upload_root.parent == local_root:
                shutil.rmtree(upload_root, ignore_errors=True)
            if tile_root.parent == local_root:
                shutil.rmtree(tile_root, ignore_errors=True)
            if export_root.parent == local_root:
                shutil.rmtree(export_root, ignore_errors=True)
        except Exception:  # noqa: BLE001 - API restore must still run
            cleanup_failures.append("artifacts")
        if restore_api:
            restored = run([*COMPOSE, "up", "-d", "api", "--wait"], check=False)
            if restored.returncode != 0:
                cleanup_failures.append("docker-api")
        if cleanup_failures:
            print("Isolated cleanup needs attention: " + ", ".join(cleanup_failures))
            if exit_code == 0:
                exit_code = 2
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
