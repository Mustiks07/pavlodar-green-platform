"""Persist immutable spatial calculation results and display artifacts."""

from pathlib import Path

from alembic import op

revision = "0016_spatial_results"
down_revision = "0015_job_requests"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0016_spatial_results.sql").read_text(encoding="utf-8")
    )


def downgrade():
    raise RuntimeError("Immutable spatial results may still be referenced by scenarios and audits")
