from datetime import UTC, datetime, timedelta
from threading import Event, Thread

import pytest
from sqlalchemy import select, text

from packages.domain.errors import DomainError
from services.api.db import session
from services.api.models import Job, Outbox, Principal, ScenarioRevision
from services.api.security import Access
from services.worker.jobs import cancel, claim, complete, dispatch, enqueue, recover
from tests.test_foundation import create_scenario

pytestmark = pytest.mark.integration


def queued(clients):
    _, _, response = create_scenario(clients["specialist"])
    with session() as db, db.begin():
        user = db.get(Principal, "00000000-0000-4000-8000-000000000002")
        revision = db.get(ScenarioRevision, response.json()["current_revision_id"])
        job = enqueue(db, Access(db, user, None), revision, "calculate")
        return job.id


def test_outbox_rolls_back_with_job(clients):
    _, _, response = create_scenario(clients["specialist"])
    with session() as db:
        user = db.get(Principal, "00000000-0000-4000-8000-000000000002")
        enqueue(
            db,
            Access(db, user, None),
            db.get(ScenarioRevision, response.json()["current_revision_id"]),
            "calculate",
        )
        db.rollback()
    with session() as db:
        assert not list(db.scalars(select(Job)))
        assert not list(db.scalars(select(Outbox)))


def test_redis_outage_preserves_outbox_and_duplicate_delivery(clients):
    job_id = queued(clients)

    def unavailable(*args):
        raise ConnectionError("broker unavailable")

    with pytest.raises(ConnectionError), session() as db, db.begin():
        dispatch(db, unavailable)
    delivered = []
    with session() as db, db.begin():
        assert db.scalar(select(Outbox)).published_at is None
        dispatch(db, lambda job_id, queue: delivered.append((job_id, queue)))
    assert delivered == [(job_id, "analysis")]
    with session() as db, db.begin():
        token = claim(db, job_id)
    with session() as db, db.begin():
        assert claim(db, job_id) is None
        # Test-only result: exercise transaction/lease machinery, not a domain calculation claim.
        complete(db, job_id, token, lambda db, job: job.input_revision_id)
    with session() as db, db.begin():
        assert claim(db, job_id) is None
        assert db.get(Job, job_id).state == "succeeded"


def test_crash_recovery_fences_old_worker_and_bounds_attempts(clients):
    job_id = queued(clients)
    previous = None
    for attempt in range(1, 4):
        with session() as db, db.begin():
            token = claim(db, job_id)
            assert token and token != previous
            if previous:
                with pytest.raises(DomainError, match="lease"):
                    complete(db, job_id, previous, lambda *_: None)
            job = db.get(Job, job_id)
            assert job.attempt == attempt
            job.lease_until = datetime.now(UTC) - timedelta(seconds=1)
        with session() as db, db.begin():
            recover(db)
            assert db.get(Job, job_id).state == ("queued" if attempt < 3 else "failed")
        previous = token


def test_cancel_prevents_publication(clients):
    job_id = queued(clients)
    with session() as db, db.begin():
        token = claim(db, job_id)
    with session() as db, db.begin():
        cancel(db, db.get(Job, job_id))

    def forbidden(*args):
        pytest.fail("Cancelled job must not publish a result")

    with session() as db, db.begin():
        complete(db, job_id, token, forbidden)
        job = db.get(Job, job_id)
        assert job.state == "cancelled" and job.payload["result_ref_id"] is None


def test_cancel_does_not_wait_for_running_result_preparation(clients):
    job_id = queued(clients)
    with session() as db, db.begin():
        token = claim(db, job_id)

    preparing = Event()
    release = Event()
    worker_errors = []

    def prepare_result(db, job):
        preparing.set()
        if not release.wait(timeout=5):
            pytest.fail("Test did not release result preparation")
        return job.input_revision_id

    def worker():
        try:
            with session() as db, db.begin():
                complete(db, job_id, token, prepare_result)
        except Exception as error:  # noqa: BLE001 - surfaced in the parent test thread
            worker_errors.append(error)

    thread = Thread(target=worker)
    thread.start()
    assert preparing.wait(timeout=5)
    try:
        with session() as db, db.begin():
            db.execute(text("SET LOCAL lock_timeout = '1s'"))
            job = db.scalar(select(Job).where(Job.id == job_id).with_for_update())
            cancel(db, job)
    finally:
        release.set()
        thread.join(timeout=5)

    assert not thread.is_alive()
    assert not worker_errors
    with session() as db:
        job = db.get(Job, job_id)
        assert job.state == "cancelled"
        assert job.payload["result_ref_id"] is None


def test_worker_rechecks_revoked_permissions(clients):
    job_id = queued(clients)
    with session() as db, db.begin():
        db.get(Principal, "00000000-0000-4000-8000-000000000002").active = False
    with session() as db, db.begin():
        assert claim(db, job_id) is None
        assert db.get(Job, job_id).payload["error"]["code"] == "job_access_revoked"
