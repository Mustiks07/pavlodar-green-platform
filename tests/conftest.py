import os
import secrets
from datetime import UTC, datetime, timedelta

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from services.api.config import settings
from services.api.db import engine, session
from services.api.main import app
from services.api.models import Base, Principal, WebSession
from services.api.security import digest
from tools.dev.seed import seed


@pytest.fixture(scope="session")
def test_database():
    configured = settings().database_url.get_secret_value()
    test_url = configured.rsplit("/", 1)[0] + "/pavlodar_test"
    admin_engine = create_engine(configured, isolation_level="AUTOCOMMIT")
    with admin_engine.connect() as conn:
        if not conn.scalar(text("SELECT 1 FROM pg_database WHERE datname='pavlodar_test'")):
            conn.execute(text("CREATE DATABASE pavlodar_test"))
    admin_engine.dispose()
    os.environ["PAVLODAR_DATABASE_URL"] = test_url
    os.environ["PAVLODAR_ENVIRONMENT"] = "test"
    settings.cache_clear()
    engine.cache_clear()
    command.upgrade(Config("alembic.ini"), "head")
    yield
    engine().dispose()


@pytest.fixture
def database(test_database):
    # Destructive cleanup is restricted to the dedicated disposable test database.
    assert engine().url.database == "pavlodar_test"
    tables = ",".join('"' + name + '"' for name in Base.metadata.tables)
    with engine().begin() as conn:
        conn.execute(text("TRUNCATE " + tables + " RESTART IDENTITY CASCADE"))
    seed()


@pytest.fixture
def clients(database):
    clients = {}
    for index, role in enumerate(["admin", "specialist", "viewer", "outsider"], 1):
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        user_id = f"00000000-0000-4000-8000-{index:012}"
        with session() as db, db.begin():
            if role == "outsider":
                db.add(
                    Principal(
                        id=user_id,
                        issuer=settings().oidc_issuer,
                        subject=user_id,
                        display_name="TEST outsider",
                        roles=["specialist"],
                        active=True,
                    )
                )
                db.flush()
            db.add(
                WebSession(
                    token_hash=digest(token),
                    user_id=user_id,
                    csrf_token=csrf,
                    expires_at=datetime.now(UTC) + timedelta(hours=1),
                )
            )
        client = TestClient(app, base_url=settings().public_origin, raise_server_exceptions=False)
        client.cookies.set("pavlodar_session", token)
        client.headers.update({"Origin": settings().public_origin, "X-CSRF-Token": csrf})
        clients[role] = client
    yield clients
    for client in clients.values():
        client.close()
