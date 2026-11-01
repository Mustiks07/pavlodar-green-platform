"""Add immutable, source-backed stock item versions."""

from pathlib import Path

from alembic import op

revision = "0013_stock_registry"
down_revision = "0012_calculation_snapshots"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0013_stock_registry.sql").read_text(encoding="utf-8")
    )


def downgrade():
    raise RuntimeError("Published stock lineage is immutable domain history")
