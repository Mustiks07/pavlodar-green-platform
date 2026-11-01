"""Add mutable work-order state and append-only execution evidence."""

from pathlib import Path

from alembic import op

revision = "0024_work_orders"
down_revision = "0023_program_revision_inputs"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0024_work_orders.sql").read_text(encoding="utf-8")
    )


def downgrade():
    raise RuntimeError("Work-order execution evidence is append-only")
