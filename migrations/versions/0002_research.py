"""Immutable research receipts and staging; no automatic canonical promotion."""

from pathlib import Path

from alembic import op

revision = "0002_research"
down_revision = "0001_foundation"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0002_research.sql").read_text(encoding="utf-8")
    )


def downgrade():
    raise RuntimeError("Archive research receipts before a reviewed destructive downgrade")
