import json

from sqlalchemy import select

from services.api.db import session
from services.api.models import Job, JobEvent
from services.worker.jobs import cancel
from tests.test_jobs import queued


def parse_sse(response):
    result = []
    for block in response.text.strip().split("\n\n"):
        fields = dict(line.split(": ", 1) for line in block.splitlines())
        result.append((fields["id"], fields["event"], json.loads(fields["data"])))
    return result


def terminal_job(clients):
    job_id = queued(clients)
    with session() as db, db.begin():
        job = db.scalar(select(Job).where(Job.id == job_id).with_for_update())
        cancel(db, job)
    return job_id


def test_job_event_stream_and_resume(clients):
    job_id = terminal_job(clients)
    response = clients["specialist"].get(f"/v1/jobs/{job_id}/events")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    events = parse_sse(response)
    assert [event[2]["state"] for event in events] == ["queued", "cancelled"]
    assert all(event[1] == "job" and event[0] == event[2]["event_id"] for event in events)

    first_id = events[0][0]
    resumed = clients["specialist"].get(
        f"/v1/jobs/{job_id}/events", headers={"Last-Event-ID": first_id}
    )
    assert [event[2]["state"] for event in parse_sse(resumed)] == ["cancelled"]
    resumed_query = clients["specialist"].get(
        f"/v1/jobs/{job_id}/events", params={"after_event_id": first_id}
    )
    assert parse_sse(resumed_query) == parse_sse(resumed)


def test_job_event_stream_hides_resources_and_rejects_invalid_cursor(clients):
    job_id = terminal_job(clients)
    with session() as db:
        another_event_id = str(
            db.scalar(
                select(JobEvent.sequence)
                .where(JobEvent.job_id != job_id)
                .order_by(JobEvent.sequence)
                .limit(1)
            )
            or 999999
        )
    assert clients["viewer"].get(f"/v1/jobs/{job_id}/events").status_code == 404
    anonymous = clients["viewer"]
    anonymous.cookies.clear()
    assert anonymous.get(f"/v1/jobs/{job_id}/events").status_code == 401
    assert (
        clients["specialist"].get(
            f"/v1/jobs/{job_id}/events", params={"after_event_id": "not-an-event"}
        ).status_code
        == 422
    )
    assert (
        clients["specialist"].get(
            f"/v1/jobs/{job_id}/events", params={"after_event_id": another_event_id}
        ).status_code
        == 422
    )
    assert (
        clients["specialist"].get(
            f"/v1/jobs/{job_id}/events",
            params={"after_event_id": "1"},
            headers={"Last-Event-ID": "2"},
        ).status_code
        == 422
    )
