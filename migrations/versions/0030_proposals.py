"""Persist reviewable scenario proposals produced by chat."""

from pathlib import Path

from alembic import op

revision = "0030_proposals"
down_revision = "0029_chat_messages"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0030_proposals.sql").read_text(encoding="utf-8")
    )


def downgrade():
    raise RuntimeError("Proposal decisions are durable audit evidence")
