"""Foundation identities, immutable versions, auth, audit, jobs and outbox."""

from pathlib import Path

from alembic import op

revision = "0001_foundation"
down_revision = None


def upgrade():
    sql = (Path(__file__).parents[1] / "sql/0001_foundation.sql").read_text(encoding="utf-8")
    op.get_bind().exec_driver_sql(sql)


def downgrade():
    raise RuntimeError(
        "Destructive downgrade disabled. Restore an approved backup into a new database."
    )
