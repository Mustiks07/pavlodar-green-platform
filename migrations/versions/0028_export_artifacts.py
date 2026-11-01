"""Persist immutable snapshot-bound PDF/XLSX exports."""

from pathlib import Path

from alembic import op

revision = "0028_export_artifacts"
down_revision = "0027_work_order_resources"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0028_export_artifacts.sql").read_text(
            encoding="utf-8"
        )
    )


def downgrade():
    raise RuntimeError("Export artifacts are immutable decision evidence")
