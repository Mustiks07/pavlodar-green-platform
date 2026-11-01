import logging
import time

from celery import Celery
from celery.exceptions import SoftTimeLimitExceeded

from packages.domain.errors import DomainError
from services.api.config import settings
from services.api.db import session
from services.api.models import Job
from services.worker.imports import persist_import
from services.worker.jobs import claim, complete, dispatch, failure, leased

celery = Celery("pavlodar", broker=settings().redis_url)
celery.conf.update(
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    task_time_limit=300,
    task_soft_time_limit=240,
    broker_connection_timeout=5,
    broker_transport_options={"visibility_timeout": 360},
    task_serializer="json",
    accept_content=["json"],
    result_backend=None,
    task_publish_retry=False,
)


@celery.task(name="pavlodar.run_job", ignore_result=True)
def run_job(job_id):
    with session() as db, db.begin():
        token = claim(db, job_id)
    if token is None:
        return
    try:
        with session() as db, db.begin():
            kind = leased(db, job_id, token).payload["kind"]
        if kind == "shadow":
            # Computes outside a transaction so cancel requests are observed (ADR-030).
            from services.api.use_cases import now
            from services.worker import jobs
            from services.worker.shadow import run_shadow

            run_shadow(job_id, token, session, jobs, now)
            return
        if kind == "chat":
            from services.api.chat import (
                grounded_fallback_reply,
                persist_chat_reply,
                prepare_chat_request,
                presentable_reply,
                server_owned_tool_reply,
            )
            from services.api.llm import LLMError, ProviderUnavailable, gateway

            with session() as db, db.begin():
                request, facts = prepare_chat_request(db, leased(db, job_id, token))
            reply = server_owned_tool_reply(request)
            if reply is None:
                try:
                    reply = gateway().complete(request)
                except ProviderUnavailable:
                    # The bounded server context remains useful when every external provider is
                    # unavailable. It never invents or mutates domain data.
                    reply = grounded_fallback_reply(request)
                except LLMError:
                    code = "operation_not_implemented"
                    with session() as db, db.begin():
                        job = db.get(Job, job_id)
                        if job and job.state in {"running", "cancel_requested"}:
                            failure(db, job, code)
                    return
            reply = presentable_reply(request, reply, facts)
            with session() as db, db.begin():
                complete(
                    db,
                    job_id,
                    token,
                    lambda current_db, current_job: persist_chat_reply(
                        current_db, current_job, reply, facts
                    ),
                )
            return
        with session() as db, db.begin():
            job = leased(db, job_id, token)
            if job.payload["kind"] == "import":
                complete(db, job_id, token, persist_import)
            elif job.payload["kind"] == "calculate":
                from services.api.calculations import persist_full_calculation

                complete(db, job_id, token, persist_full_calculation)
            elif job.payload["kind"] == "optimize":
                from services.worker.programs import persist_optimization

                complete(db, job_id, token, persist_optimization)
            elif job.payload["kind"] == "export":
                from services.api.exports import persist_export

                complete(db, job_id, token, persist_export)
            elif job.payload["kind"] == "thermal":
                from services.worker.thermal import persist_thermal

                complete(db, job_id, token, persist_thermal)
            else:
                # No fake successful calculations: handlers arrive with their work packages.
                failure(db, job, "handler_not_available")
    except DomainError as error:
        with session() as db, db.begin():
            job = db.get(Job, job_id)
            if job and job.state in {"running", "cancel_requested"}:
                failure(db, job, error.code)
    except SoftTimeLimitExceeded:
        # A deterministic overrun would time out again: fail now instead of a lease-expiry retry.
        with session() as db, db.begin():
            job = db.get(Job, job_id)
            if job and job.state in {"running", "cancel_requested"}:
                failure(db, job, "job_timeout")


def dispatch_once():
    with session() as db, db.begin():
        dispatch(
            db,
            lambda job_id, queue: celery.send_task("pavlodar.run_job", args=[job_id], queue=queue),
        )


if __name__ == "__main__":
    while True:
        try:
            dispatch_once()
        except Exception:  # noqa: BLE001 - trust boundary: never expose secret-bearing exceptions
            logging.getLogger("pavlodar.worker").warning("outbox_retry_pending")
        time.sleep(5)
