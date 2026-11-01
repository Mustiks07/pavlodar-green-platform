"""Indexed imported geometry and immutable map-layer manifests."""

from pathlib import Path

from alembic import op

revision = "0006_map_layers"
down_revision = "0005_generic_import"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0006_map_layers.sql").read_text(encoding="utf-8")
    )


def downgrade():
    raise RuntimeError("Archive published map layers before a reviewed destructive downgrade")
