"""Add source-backed rate versions and immutable calculation snapshots."""

from pathlib import Path

from alembic import op

revision = "0012_calculation_snapshots"
down_revision = "0011_catalog_rules"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0012_calculation_snapshots.sql").read_text(
            encoding="utf-8"
        )
    )


def downgrade():
    raise RuntimeError("Calculation snapshots and rate lineage are immutable domain history")
