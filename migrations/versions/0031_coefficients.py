"""Add immutable, source-backed coefficient versions."""

from pathlib import Path

from alembic import op

revision = "0031_coefficients"
down_revision = "0030_proposals"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0031_coefficients.sql").read_text(
            encoding="utf-8"
        )
    )


def downgrade():
    raise RuntimeError("Coefficient versions are immutable calculation lineage")
