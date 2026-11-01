"""Normalize the exact calculation snapshots used by each program revision."""

from pathlib import Path

from alembic import op

revision = "0022_program_calc_lineage"
down_revision = "0021_program_jobs"


def upgrade():
    op.get_bind().exec_driver_sql(
        (
            Path(__file__).parents[1]
            / "sql/0022_program_revision_calculations.sql"
        ).read_text(encoding="utf-8")
    )


def downgrade():
    raise RuntimeError("Program calculation lineage is immutable decision evidence")
