"""Add immutable global catalog snapshots and source-backed rule versions."""

from pathlib import Path

from alembic import op

revision = "0011_catalog_rules"
down_revision = "0010_address_index"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0011_catalog_rules.sql").read_text(encoding="utf-8")
    )


def downgrade():
    raise RuntimeError("Catalog snapshots and rule lineage are immutable domain history")
