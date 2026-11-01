"""Normalize the exact scenario placement behind every cohort."""

from pathlib import Path

from alembic import op

revision = "0026_cohort_placement"
down_revision = "0025_cohorts_inspections"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0026_cohort_placement.sql").read_text(
            encoding="utf-8"
        )
    )


def downgrade():
    raise RuntimeError("Exact cohort placement lineage is immutable")
