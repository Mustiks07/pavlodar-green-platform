"""Index deterministic identifiers used by MVT features and feature detail reads."""

from pathlib import Path

from alembic import op

revision = "0008_map_feature_ids"
down_revision = "0007_map_layer_backfill"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0008_map_feature_ids.sql").read_text(
            encoding="utf-8"
        )
    )


def downgrade():
    raise RuntimeError("Map feature identifiers are published API lineage")
