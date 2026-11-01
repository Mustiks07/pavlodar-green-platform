"""Allow durable jobs to carry immutable work-calendar export snapshots."""

from pathlib import Path

from alembic import op

revision = "0033_work_calendar_exports"
down_revision = "0032_problem_decisions"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0033_work_calendar_exports.sql").read_text(
            encoding="utf-8"
        )
    )


def downgrade():
    raise RuntimeError("Work-calendar export snapshots are durable audit evidence")
