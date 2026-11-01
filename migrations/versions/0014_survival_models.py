"""Add immutable source-backed survival model versions."""

from pathlib import Path

from alembic import op

revision = "0014_survival_models"
down_revision = "0013_stock_registry"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0014_survival_models.sql").read_text(
            encoding="utf-8"
        )
    )


def downgrade():
    raise RuntimeError("Published survival model lineage is immutable domain history")
