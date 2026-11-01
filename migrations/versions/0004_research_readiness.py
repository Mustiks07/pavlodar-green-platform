"""Backfill exact readiness metadata for the immutable reviewed research receipt."""

from pathlib import Path

from alembic import op

revision = "0004_research_readiness"
down_revision = "0003_contract_1_1"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0004_research_readiness.sql").read_text(encoding="utf-8")
    )


def downgrade():
    raise RuntimeError("Research readiness provenance backfill is intentionally irreversible")
