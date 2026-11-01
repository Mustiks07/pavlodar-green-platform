"""Create a provenance-preserving local address index from published versions."""

from pathlib import Path

from alembic import op

revision = "0010_address_index"
down_revision = "0009_map_layer_dataset_id"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0010_address_index.sql").read_text(encoding="utf-8")
    )


def downgrade():
    raise RuntimeError("Address provenance is published API lineage; destructive downgrade refused")
