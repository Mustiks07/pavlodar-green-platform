"""Authorized resumable Server-Sent Events for durable Job transitions."""

import asyncio
import json

from fastapi import Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from packages.domain.contracts import validate
from packages.domain.errors import DomainError
from services.api.db import session
from services.api.models import Job, JobEvent
from services.api.security import authenticate
from services.api.use_cases import found
from services.worker.jobs import TERMINAL, authorize_job_input

POLL_SECONDS = 0.5
HEARTBEAT_SECONDS = 15.0
PAGE_SIZE = 100


def _authorize(db, request, job_id):
    access = authenticate(db, request)
    access.role("viewer")
    job = found(db.get(Job, job_id))
    access.city(job.city_id)
    if job.owner_id != access.user.id and access.level < 2:
        raise DomainError(404, "not_found", "Object not found")
    authorize_job_input(db, access, job)
    return job


def _cursor(request):
    query_value = request.query_params.get("after_event_id")
    header_value = request.headers.get("last-event-id")
    if query_value and header_value and query_value != header_value:
        raise DomainError(422, "invalid_parameter", "Event cursors do not match")
    value = query_value or header_value
    if value is None:
        return 0
    try:
        cursor = int(value)
    except ValueError:
        raise DomainError(422, "invalid_parameter", "Event cursor must be an integer") from None
    if cursor < 1 or str(cursor) != value:
        raise DomainError(422, "invalid_parameter", "Event cursor is invalid")
    return cursor


def _read(request, job_id, cursor, *, validate_cursor=False):
    with session() as db:
        job = _authorize(db, request, job_id)
        if validate_cursor and not db.scalar(
            select(JobEvent.sequence).where(
                JobEvent.sequence == cursor, JobEvent.job_id == job_id
            )
        ):
            raise DomainError(422, "invalid_parameter", "Event cursor does not belong to this job")
        rows = list(
            db.scalars(
                select(JobEvent)
                .where(JobEvent.job_id == job_id, JobEvent.sequence > cursor)
                .order_by(JobEvent.sequence)
                .limit(PAGE_SIZE)
            )
        )
        events = []
        for row in rows:
            value = {"event_id": str(row.sequence), **row.payload}
            validate("JobEvent", value)
            events.append(value)
        return events, job.state in TERMINAL


def _encode(event):
    data = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    return f"id: {event['event_id']}\nevent: job\ndata: {data}\n\n"


async def stream_job_events(request: Request):
    job_id = request.path_params["job_id"]
    cursor = _cursor(request)
    # Authenticate, authorize and validate resume state before response headers are sent.
    _read(request, job_id, cursor, validate_cursor=bool(cursor))

    async def events():
        nonlocal cursor
        heartbeat_elapsed = 0.0
        while not await request.is_disconnected():
            try:
                values, terminal = _read(request, job_id, cursor)
            except (DomainError, SQLAlchemyError):
                # Headers have already been sent. Stop rather than disclose a revocation reason.
                return
            for value in values:
                cursor = int(value["event_id"])
                yield _encode(value)
                heartbeat_elapsed = 0.0
            if terminal and not values:
                return
            if terminal:
                # Re-read once so a transition committed between the page query and terminal
                # observation is not skipped. The next iteration closes when no rows remain.
                continue
            await asyncio.sleep(POLL_SECONDS)
            heartbeat_elapsed += POLL_SECONDS
            if heartbeat_elapsed >= HEARTBEAT_SECONDS:
                yield ": keep-alive\n\n"
                heartbeat_elapsed = 0.0

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-store",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
