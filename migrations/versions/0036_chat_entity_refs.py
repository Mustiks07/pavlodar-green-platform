"""Persist bounded authorized entity references returned by assistant search."""

from pathlib import Path

from alembic import op

revision = "0036_chat_entity_refs"
down_revision = "0035_chat_report_jobs"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0036_chat_entity_refs.sql").read_text(
            encoding="utf-8"
        )
    )


def downgrade():
    raise RuntimeError("Assistant entity references are durable conversation evidence")
