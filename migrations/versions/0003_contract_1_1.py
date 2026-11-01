"""Adapt stored dataset-version read models to canonical contract 1.1.0."""

from pathlib import Path

from alembic import op

revision = "0003_contract_1_1"
down_revision = "0002_research"


def upgrade():
    op.get_bind().exec_driver_sql(
        (Path(__file__).parents[1] / "sql/0003_contract_1_1.sql").read_text(encoding="utf-8")
    )


def downgrade():
    raise RuntimeError("Canonical 1.1 read-model migration is intentionally irreversible")
