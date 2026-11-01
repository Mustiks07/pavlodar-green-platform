"""Expose the stable dataset identity in every published map-layer manifest."""

from pathlib import Path

from alembic import op

revision = "0009_map_layer_dataset_id"
down_revision = "0008_map_feature_ids"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0009_map_layer_dataset_id.sql").read_text(
            encoding="utf-8"
        )
    )


def downgrade():
    raise RuntimeError("Published map-layer dataset identities are canonical API lineage")

