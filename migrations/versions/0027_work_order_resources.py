"""Bind care work orders to frozen calendar operations and resource periods."""

from pathlib import Path

from alembic import op

revision = "0027_work_order_resources"
down_revision = "0026_cohort_placement"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0027_work_order_resources.sql").read_text(
            encoding="utf-8"
        )
    )


def downgrade():
    raise RuntimeError("Executed care resource lineage is decision evidence")
