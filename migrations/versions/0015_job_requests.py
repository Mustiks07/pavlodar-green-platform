"""Persist private canonical request bodies for durable jobs."""

from pathlib import Path

from alembic import op

revision = "0015_job_requests"
down_revision = "0014_survival_models"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0015_job_requests.sql").read_text(encoding="utf-8")
    )


def downgrade():
    raise RuntimeError("Durable calculation job requests may still be required for recovery")
