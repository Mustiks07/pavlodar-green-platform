"""Link one assistant message to one durable snapshot report job."""

from pathlib import Path

from alembic import op

revision = "0035_chat_report_jobs"
down_revision = "0034_work_calendar_artifacts"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0035_chat_report_jobs.sql").read_text(
            encoding="utf-8"
        )
    )


def downgrade():
    raise RuntimeError("Assistant-created report jobs are durable audit evidence")
