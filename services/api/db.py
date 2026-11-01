from functools import lru_cache

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from services.api.config import settings


@lru_cache
def engine():
    return create_engine(
        settings().database_url.get_secret_value(),
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=5,
        pool_timeout=5,
        connect_args={"connect_timeout": 5},
    )


def session():
    return Session(engine(), expire_on_commit=False)
