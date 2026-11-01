"""Allow durable jobs to reference immutable program input versions."""

from pathlib import Path

from alembic import op

revision = "0021_program_jobs"
down_revision = "0020_program_priority_reference"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0021_program_jobs.sql").read_text(encoding="utf-8")
    )


def downgrade():
    raise RuntimeError("Program jobs may already reference immutable program inputs")
