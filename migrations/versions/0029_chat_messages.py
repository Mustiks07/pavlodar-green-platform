"""Persist authorized chat sessions and durable messages."""

from pathlib import Path

from alembic import op

revision = "0029_chat_messages"
down_revision = "0028_export_artifacts"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0029_chat_messages.sql").read_text(encoding="utf-8")
    )


def downgrade():
    raise RuntimeError("Chat messages are durable audit evidence")
