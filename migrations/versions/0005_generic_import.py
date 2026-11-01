"""Durable generic uploads, import records and job inputs."""

from pathlib import Path

from alembic import op

revision = "0005_generic_import"
down_revision = "0004_research_readiness"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0005_generic_import.sql").read_text(encoding="utf-8")
    )


def downgrade():
    raise RuntimeError("Archive uploads and import lineage before a reviewed destructive downgrade")
