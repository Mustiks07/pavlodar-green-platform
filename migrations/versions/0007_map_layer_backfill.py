"""Create manifests for vector versions published before map-layer support."""

from pathlib import Path

from alembic import op

revision = "0007_map_layer_backfill"
down_revision = "0006_map_layers"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0007_map_layer_backfill.sql").read_text(
            encoding="utf-8"
        )
    )


def downgrade():
    raise RuntimeError("Map layer manifests are immutable publication lineage")
