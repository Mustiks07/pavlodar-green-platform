"""Add immutable city-program inputs and optimization revisions."""

from pathlib import Path

from alembic import op

revision = "0018_programs"
down_revision = "0017_map_archives"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0018_programs.sql").read_text(encoding="utf-8")
    )


def downgrade():
    raise RuntimeError("Program input and solver revisions are immutable decision evidence")
