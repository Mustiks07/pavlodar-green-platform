"""Normalize the program input version behind every solver revision."""

from pathlib import Path

from alembic import op

revision = "0023_program_revision_inputs"
down_revision = "0022_program_calc_lineage"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0023_program_revision_inputs.sql").read_text(
            encoding="utf-8"
        )
    )


def downgrade():
    raise RuntimeError("Program revision input lineage is immutable decision evidence")
