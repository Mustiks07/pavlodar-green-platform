"""Add evidence-backed planting cohorts, inspections and replacement lineage."""

from pathlib import Path

from alembic import op

revision = "0025_cohorts_inspections"
down_revision = "0024_work_orders"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0025_cohorts_inspections.sql").read_text(
            encoding="utf-8"
        )
    )


def downgrade():
    raise RuntimeError("Cohort and inspection evidence is immutable")
