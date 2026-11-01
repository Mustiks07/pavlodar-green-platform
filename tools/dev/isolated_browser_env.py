"""Run browser checks against a fully separate disposable stack; the shared dev API is untouched.

Unlike ``browser_test_env`` (which temporarily replaces the shared API on :8001 so the OIDC test
client allowlisted for :5173 keeps working), this runner starts its own API on :8011, its own
Vite on :5174, its own worker and dispatcher, its own database and Redis DB. It never calls
Docker and never stops anything it did not start. Login skips the identity provider: sessions
for the seeded SYNTHETIC TEST users are created in the disposable database (as the backend test
suite does) and their cookies are handed to the browser checks through ``PG_SESSIONS``.

    uv run python -m tools.dev.isolated_browser_env --cwd apps/web -- node scripts/layers-check.mjs

Needs the usual PAVLODAR_* settings in the environment (local PostgreSQL/Redis, test realm).
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
TARGET_DATABASE = "pavlodar_claude_isolated"
REDIS_DB = 10
API_PORT = 8011
WEB_PORT = 5174
LLM_PORT = 8019
API_ORIGIN = f"http://127.0.0.1:{API_PORT}"
WEB_ORIGIN = f"http://localhost:{WEB_PORT}"
ROLES = ["admin", "specialist", "viewer"]


def run(command, *, env=None):
    return subprocess.run(command, cwd=ROOT, env=env, check=True, text=True, capture_output=True)


def urls():
    source = make_url(settings().database_url.get_secret_value())
    if source.host not in {"127.0.0.1", "localhost"}:
        raise SystemExit("Isolation only accepts the local PostgreSQL host")
    if source.database == TARGET_DATABASE:
        raise SystemExit("Main database URL unexpectedly points at the disposable target")
    redis_url = make_url(settings().redis_url)
    if redis_url.host not in {"127.0.0.1", "localhost"}:
        raise SystemExit("Isolation only accepts the local Redis host")
    return source, source.set(database=TARGET_DATABASE), redis_url.set(database=str(REDIS_DB))


def recreate(source, *, create=True):
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
        if create:
            connection.exec_driver_sql(f'CREATE DATABASE "{TARGET_DATABASE}"')
    admin.dispose()


def port_free(port):
    try:
        httpx.get(f"http://127.0.0.1:{port}/", timeout=1)
    except httpx.HTTPError:
        return True
    return False


def wait_ready(url, processes, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        failed = [name for name, process, _ in processes if process.poll() is not None]
        if failed:
            raise RuntimeError("Isolated process exited early: " + ", ".join(failed))
        try:
            if httpx.get(url, timeout=2).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.5)
    raise RuntimeError(f"Timed out waiting for {url}")


def start(name, command, env, logs):
    stream = (logs / f"{name}.log").open("wb")
    kwargs = (
        {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
        if os.name == "nt"
        else {"start_new_session": True}
    )
    process = subprocess.Popen(
        command, cwd=ROOT, env=env, stdout=stream, stderr=subprocess.STDOUT, **kwargs
    )
    return name, process, stream


def stop(item):
    _, process, stream = item
    if process.poll() is None:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"], check=False, capture_output=True
            )
        else:
            os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            if os.name != "nt":
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=10)
    stream.close()


def create_sessions(env, path):
    """Sessions for the seeded users, created in the disposable database only."""
    code = f"""
import json, secrets
from datetime import UTC, datetime, timedelta
from services.api.db import session
from services.api.models import WebSession
from services.api.security import digest
out = {{}}
with session() as db, db.begin():
    for index, role in enumerate({ROLES!r}, start=1):
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        db.add(WebSession(token_hash=digest(token), user_id=f"00000000-0000-4000-8000-{{index:012}}",
                          csrf_token=csrf, expires_at=datetime.now(UTC) + timedelta(hours=6)))
        out[role] = {{"cookie": token}}
open({str(path)!r}, "w", encoding="utf-8").write(json.dumps(out))
"""
    run(["uv", "run", "python", "-c", code], env=env)


def main():
    parser = argparse.ArgumentParser(description="Browser checks on a separate disposable stack")
    parser.add_argument("--cwd", default=".", help="command directory inside the repository")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("provide a command after --")
    command_cwd = (ROOT / args.cwd).resolve()
    if command_cwd != ROOT and ROOT not in command_cwd.parents:
        parser.error("--cwd must stay inside the repository")
    for port in (API_PORT, WEB_PORT, LLM_PORT):
        if not port_free(port):
            raise SystemExit(f"Port {port} is busy; another isolated run is active")

    source, target, redis_url = urls()
    work = Path(tempfile.mkdtemp(prefix="pg-isolated-"))
    logs = work / "logs"
    logs.mkdir()
    env = os.environ.copy()
    env.update(
        {
            "PAVLODAR_DATABASE_URL": target.render_as_string(hide_password=False),
            "PAVLODAR_REDIS_URL": redis_url.render_as_string(hide_password=False),
            "PAVLODAR_ENVIRONMENT": "test",
            "PAVLODAR_PUBLIC_ORIGIN": WEB_ORIGIN,
            "PAVLODAR_COOKIE_SECURE": "false",
            "PAVLODAR_OIDC_INTERNAL_ORIGIN": "",
            "PAVLODAR_UPLOAD_ROOT": str(work / "uploads"),
            "PAVLODAR_TILE_ROOT": str(work / "tiles"),
            "PAVLODAR_EXPORT_ROOT": str(work / "exports"),
            # Chat runs against the deterministic loopback stub; no request leaves the machine.
            "PAVLODAR_LLM_PROVIDER": "local",
            "PAVLODAR_LLM_FALLBACK_PROVIDERS": "",
            "PAVLODAR_LLM_MODEL": "synthetic-stub",
            "PAVLODAR_LLM_LOCAL_BASE_URL": f"http://127.0.0.1:{LLM_PORT}/v1",
            "PG_API_ORIGIN": API_ORIGIN,
            "PG_WEB_URL": WEB_ORIGIN,
            "PG_VITE_CACHE_DIR": str(ROOT / "apps/web/node_modules/.vite-isolated"),
            "PG_SESSIONS": str(work / "sessions.json"),
            "PYTHONUNBUFFERED": "1",
        }
    )
    processes = []
    exit_code = 1
    try:
        recreate(source)
        redis.Redis.from_url(env["PAVLODAR_REDIS_URL"]).flushdb()
        run(["uv", "run", "alembic", "upgrade", "head"], env=env)
        run(["uv", "run", "python", "-m", "tools.dev.seed", "--profile", "test"], env=env)
        create_sessions(env, work / "sessions.json")
        processes.append(
            start(
                "llm-stub",
                ["uv", "run", "python", "-m", "tools.dev.llm_stub", "--port", str(LLM_PORT)],
                env,
                logs,
            )
        )
        queues = "import,analysis,export,physical"
        processes.append(
            start(
                "worker",
                [
                    "uv",
                    "run",
                    "celery",
                    "-A",
                    "services.worker.main:celery",
                    "worker",
                    "-Q",
                    queues,
                    "--pool=solo",
                    "--concurrency=1",
                    "--loglevel=warning",
                ],
                env,
                logs,
            )
        )
        processes.append(
            start("dispatcher", ["uv", "run", "python", "-m", "services.worker.main"], env, logs)
        )
        processes.append(
            start(
                "api",
                [
                    "uv",
                    "run",
                    "uvicorn",
                    "services.api.main:app",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(API_PORT),
                    "--workers",
                    os.environ.get("PG_ISOLATED_API_WORKERS", "1"),
                    "--no-access-log",
                ],
                env,
                logs,
            )
        )
        wait_ready(API_ORIGIN + "/health/ready", processes)
        npm = "npm.cmd" if os.name == "nt" else "npm"
        processes.append(
            start(
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
                    "--port",
                    str(WEB_PORT),
                    "--strictPort",
                ],
                env,
                logs,
            )
        )
        wait_ready(f"http://127.0.0.1:{WEB_PORT}/", processes)
        print(
            f"Isolated browser environment ready: {TARGET_DATABASE}, API {API_ORIGIN}, web {WEB_ORIGIN}",
            flush=True,
        )
        exit_code = subprocess.run(command, cwd=command_cwd, env=env, check=False).returncode
    finally:
        for item in reversed(processes):
            stop(item)
        try:
            recreate(source, create=False)
            redis.Redis.from_url(env["PAVLODAR_REDIS_URL"]).flushdb()
        finally:
            shutil.rmtree(work, ignore_errors=True)
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
