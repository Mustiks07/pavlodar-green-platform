"""Persist specialist decisions for derived spatial problems."""

from pathlib import Path

from alembic import op

revision = "0032_problem_decisions"
down_revision = "0031_coefficients"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0032_problem_decisions.sql").read_text(
            encoding="utf-8"
        )
    )


def downgrade():
    raise RuntimeError("Problem decisions are durable audit evidence")
