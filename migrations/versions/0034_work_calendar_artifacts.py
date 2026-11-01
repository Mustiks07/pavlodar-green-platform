"""Allow immutable export artifacts to target a city work calendar."""

from pathlib import Path

from alembic import op

revision = "0034_work_calendar_artifacts"
down_revision = "0033_work_calendar_exports"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0034_work_calendar_artifacts.sql").read_text(
            encoding="utf-8"
        )
    )


def downgrade():
    raise RuntimeError("Work-calendar export artifacts are durable audit evidence")
