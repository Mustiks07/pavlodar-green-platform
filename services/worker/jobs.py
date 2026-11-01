"""Durable job state, fenced leases and an at-least-once transactional outbox."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from packages.domain.errors import DomainError
from services.api.models import (
    City,
    Dataset,
    Job,
    JobEvent,
    Outbox,
    Principal,
    Program,
    ProgramInputVersion,
    ProgramRevisionRecord,
    Upload,
)
from services.api.security import Access
from services.api.use_cases import authorized_revision, found, now, uid

TERMINAL = {"succeeded", "failed", "cancelled"}
QUEUES = {
    "import": "import",
    "calculate": "analysis",
    "optimize": "analysis",
    "shadow": "physical",
    "thermal": "physical",
    "export": "export",
    "chat": "analysis",
}


def event(db, job):
    db.add(
        JobEvent(
            job_id=job.id,
            payload={
                "job_id": job.id,
                "state": job.state,
                "phase": job.payload["phase"],
                "progress": job.payload["progress"],
                "occurred_at": now(),
            },
        )
    )


def state(db, job, target, **changes):
    job.state = target
    job.payload = {**job.payload, "state": target, **changes}
    if job.payload.get("kind") == "chat":
        from services.api.models import ChatMessageRecord

        message = db.scalar(select(ChatMessageRecord).where(ChatMessageRecord.job_id == job.id))
        mapped = {"running": "streaming", "failed": "failed", "cancelled": "cancelled"}
        if message and target in mapped:
            message.state = mapped[target]
    event(db, job)


def enqueue(db, access, revision, kind, request_payload=None):
    access.role("specialist")
    authorized_revision(db, access, revision.id)
    job_id = uid()
    payload = {
        "id": job_id,
        "kind": kind,
        "state": "queued",
        "phase": None,
        "progress": None,
        "input_ref_id": revision.id,
        "result_ref_id": None,
        "attempt": 0,
        "created_at": now(),
        "started_at": None,
        "completed_at": None,
        "error": None,
    }
    from services.api.models import Scenario

    scenario = db.get(Scenario, revision.scenario_id)
    job = Job(
        id=job_id,
        owner_id=access.user.id,
        city_id=scenario.city_id,
        input_revision_id=revision.id,
        input_ref_id=revision.id,
        input_kind="revision",
        state="queued",
        attempt=0,
        request_payload=request_payload,
        payload=payload,
    )
    db.add(job)
    db.flush()
    db.add(Outbox(id=uid(), job_id=job.id, queue=QUEUES[kind], created_at=datetime.now(UTC)))
    event(db, job)
    return job


def enqueue_import(db, access, dataset, upload, request):
    access.role("specialist")
    access.dataset(dataset)
    job_id = uid()
    payload = {
        "id": job_id,
        "kind": "import",
        "state": "queued",
        "phase": "quarantine_complete",
        "progress": 0,
        "input_ref_id": upload.id,
        "result_ref_id": None,
        "attempt": 0,
        "created_at": now(),
        "started_at": None,
        "completed_at": None,
        "error": None,
    }
    job = Job(
        id=job_id,
        owner_id=access.user.id,
        city_id=dataset.city_id,
        input_revision_id=None,
        input_ref_id=upload.id,
        input_kind="upload",
        state="queued",
        attempt=0,
        request_payload=request,
        payload=payload,
    )
    db.add(job)
    db.flush()
    db.add(Outbox(id=uid(), job_id=job.id, queue="import", created_at=datetime.now(UTC)))
    event(db, job)
    return job


def enqueue_program(db, access, program, request):
    access.role("specialist")
    from services.api.programs import get_program

    get_program(db, access, program.id, mutate=True)
    input_version = found(db.get(ProgramInputVersion, program.current_input_version_id))
    job_id = uid()
    payload = {
        "id": job_id,
        "kind": "optimize",
        "state": "queued",
        "phase": None,
        "progress": None,
        "input_ref_id": input_version.id,
        "result_ref_id": None,
        "attempt": 0,
        "created_at": now(),
        "started_at": None,
        "completed_at": None,
        "error": None,
    }
    job = Job(
        id=job_id,
        owner_id=access.user.id,
        city_id=program.city_id,
        input_revision_id=None,
        input_ref_id=input_version.id,
        input_kind="program",
        state="queued",
        attempt=0,
        request_payload=request,
        payload=payload,
    )
    db.add(job)
    db.flush()
    db.add(Outbox(id=uid(), job_id=job.id, queue=QUEUES["optimize"], created_at=datetime.now(UTC)))
    event(db, job)
    return job


def enqueue_export(db, access, request):
    access.role("specialist")
    from services.api.exports import _target

    _, city_id = _target(db, access, request["target_kind"], request["target_id"])
    frozen_request = dict(request)
    if request["target_kind"] == "work_calendar":
        from services.api.work_orders import freeze_work_calendar

        if request["format"] != "xlsx":
            raise DomainError(422, "export_format_invalid", "Work calendar export is XLSX only")
        frozen_request["work_calendar_snapshot"] = freeze_work_calendar(
            db,
            access,
            city_id,
            request.get("filters") or {},
            now(),
        )
    job_id = uid()
    payload = {
        "id": job_id,
        "kind": "export",
        "state": "queued",
        "phase": None,
        "progress": None,
        "input_ref_id": request["target_id"],
        "result_ref_id": None,
        "attempt": 0,
        "created_at": now(),
        "started_at": None,
        "completed_at": None,
        "error": None,
    }
    job = Job(
        id=job_id,
        owner_id=access.user.id,
        city_id=city_id,
        input_revision_id=None,
        input_ref_id=request["target_id"],
        input_kind=request["target_kind"],
        state="queued",
        attempt=0,
        request_payload=frozen_request,
        payload=payload,
    )
    db.add(job)
    db.flush()
    db.add(Outbox(id=uid(), job_id=job.id, queue=QUEUES["export"], created_at=datetime.now(UTC)))
    event(db, job)
    return job


def authorize_job_input(db, access, job):
    if job.input_kind == "revision":
        authorized_revision(db, access, job.input_revision_id)
        return
    if job.input_kind == "upload":
        upload = found(db.get(Upload, job.input_ref_id))
        access.dataset(found(db.get(Dataset, upload.dataset_id)))
        if upload.owner_id != job.owner_id:
            raise DomainError(403, "job_access_revoked", "Upload ownership changed")
        return
    if job.input_kind == "program":
        input_version = found(db.get(ProgramInputVersion, job.input_ref_id))
        program = found(db.get(Program, input_version.program_id))
        from services.api.programs import get_program, validate_program_input

        get_program(db, access, program.id, mutate=True)
        validate_program_input(db, access, input_version.payload)
        return
    if job.input_kind == "calculation":
        from services.api.calculations import authorized_snapshot

        authorized_snapshot(db, access, job.input_ref_id)
        return
    if job.input_kind == "program_revision":
        from services.api.programs import program_revision_access

        program_revision_access(db, access, found(db.get(ProgramRevisionRecord, job.input_ref_id)))
        return
    if job.input_kind == "chat_session":
        from services.api.chat import session_access

        session_access(db, access, job.input_ref_id)
        if job.owner_id != access.user.id:
            raise DomainError(403, "job_access_revoked", "Chat job ownership changed")
        return
    if job.input_kind == "work_calendar":
        city = found(db.get(City, job.input_ref_id))
        access.city(city.id)
        if job.owner_id != access.user.id:
            raise DomainError(403, "job_access_revoked", "Calendar export ownership changed")
        return
    raise DomainError(500, "job_input_invalid", "Job input kind is invalid")


def failure(db, job, code):
    state(
        db,
        job,
        "failed",
        completed_at=now(),
        error={
            "type": "https://team-vtiposhnik.example/problems/" + code,
            "title": code,
            "status": 503,
            "detail": "Job could not be completed",
            "code": code,
            "request_id": uid(),
            "current_revision_id": None,
            "field_errors": [],
            "blockers": [],
        },
    )
    job.lease_token, job.lease_until = None, None


def claim(db, job_id):
    job = found(db.scalar(select(Job).where(Job.id == job_id).with_for_update()))
    if job.state != "queued":
        return None
    user = db.get(Principal, job.owner_id)
    try:
        if not user or not user.active:
            raise DomainError(403, "job_access_revoked", "Access revoked")
        access = Access(db, user, None)
        access.role("specialist")
        authorize_job_input(db, access, job)
    except DomainError:
        failure(db, job, "job_access_revoked")
        return None
    job.attempt += 1
    job.lease_token = uid()
    job.lease_until = datetime.now(UTC) + timedelta(seconds=300)
    state(db, job, "running", attempt=job.attempt, started_at=job.payload["started_at"] or now())
    return job.lease_token


def leased(db, job_id, token):
    job = found(
        db.scalar(
            select(Job)
            .where(Job.id == job_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    )
    if (
        job.state not in {"running", "cancel_requested"}
        or job.lease_token != token
        or job.lease_until <= datetime.now(UTC)
    ):
        raise DomainError(409, "lease_lost", "Worker lease is no longer current")
    return job


def heartbeat(db, job_id, token):
    job = leased(db, job_id, token)
    if job.state == "cancel_requested":
        return False
    job.lease_until = datetime.now(UTC) + timedelta(seconds=300)
    return True


def complete(db, job_id, token, persist_result):
    # Read the immutable request and lease without holding the Job row lock while a parser or
    # calculation runs. cancelJob can therefore commit cancel_requested immediately. The
    # result is prepared in a savepoint, then the fenced lease is locked and refreshed before
    # publication. If cancellation won the race, rolling back the savepoint discards every
    # result/audit write before the job becomes cancelled.
    job = found(
        db.scalar(
            select(Job).where(Job.id == job_id).execution_options(populate_existing=True)
        )
    )
    if (
        job.state not in {"running", "cancel_requested"}
        or job.lease_token != token
        or job.lease_until <= datetime.now(UTC)
    ):
        raise DomainError(409, "lease_lost", "Worker lease is no longer current")
    if job.state == "cancel_requested":
        job = leased(db, job_id, token)
        state(db, job, "cancelled", completed_at=now())
        job.lease_token, job.lease_until = None, None
        return

    result_scope = db.begin_nested()
    try:
        result_id = persist_result(db, job)
        db.flush()
        job = leased(db, job_id, token)
        if job.state == "cancel_requested":
            result_scope.rollback()
            job = leased(db, job_id, token)
            state(db, job, "cancelled", completed_at=now())
        else:
            result_scope.commit()
            state(db, job, "succeeded", result_ref_id=result_id, completed_at=now())
    except Exception:
        if result_scope.is_active:
            result_scope.rollback()
        raise
    job.lease_token, job.lease_until = None, None


def cancel(db, job):
    if job.state == "queued":
        state(db, job, "cancelled", completed_at=now())
    elif job.state == "running":
        state(db, job, "cancel_requested")


def recover(db):
    expired = db.scalars(
        select(Job)
        .where(Job.state.in_(["running", "cancel_requested"]), Job.lease_until < datetime.now(UTC))
        .with_for_update(skip_locked=True)
    )
    for job in expired:
        if job.state == "cancel_requested":
            state(db, job, "cancelled", completed_at=now())
        elif job.attempt >= 3:
            failure(db, job, "attempts_exhausted")
        else:
            state(db, job, "queued", phase="recovering")
            outbox = db.scalar(select(Outbox).where(Outbox.job_id == job.id))
            outbox.published_at = None
        job.lease_token, job.lease_until = None, None


def dispatch(db, publish):
    recover(db)
    cutoff = datetime.now(UTC) - timedelta(seconds=30)
    entries = db.scalars(
        select(Outbox)
        .join(Job, Outbox.job_id == Job.id)
        .where(
            Job.state == "queued", (Outbox.published_at.is_(None) | (Outbox.published_at < cutoff))
        )
        .with_for_update(of=Outbox, skip_locked=True)
        .limit(100)
    )
    for entry in entries:
        publish(entry.job_id, entry.queue)
        # Crash between publish and commit causes redelivery; claim() deduplicates.
        entry.published_at = datetime.now(UTC)
