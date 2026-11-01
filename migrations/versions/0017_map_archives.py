"""Register immutable PMTiles artifacts for authorized Range delivery."""

from pathlib import Path

from alembic import op

revision = "0017_map_archives"
down_revision = "0016_spatial_results"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0017_map_archives.sql").read_text(encoding="utf-8")
    )


def downgrade():
    raise RuntimeError("Published map archive registry entries are immutable delivery evidence")
