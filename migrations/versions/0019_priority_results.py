"""Persist immutable, reproducible priority results."""

from pathlib import Path

from alembic import op

revision = "0019_priority_results"
down_revision = "0018_programs"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0019_priority_results.sql").read_text(
            encoding="utf-8"
        )
    )


def downgrade():
    raise RuntimeError("Priority results are immutable decision evidence")
