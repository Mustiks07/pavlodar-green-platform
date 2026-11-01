"""Bind every optimizable program input to an immutable priority result."""

from pathlib import Path

from alembic import op

revision = "0020_program_priority_reference"
down_revision = "0019_priority_results"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0020_program_priority_reference.sql").read_text(
            encoding="utf-8"
        )
    )


def downgrade():
    raise RuntimeError("Program-to-priority links are immutable decision evidence")
