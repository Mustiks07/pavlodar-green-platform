"""Persist an explicit data-gated thermal result without fabricating model output."""

import uuid
from datetime import UTC, datetime

from services.api.models import SpatialResultRecord

RESULT_NAMESPACE = uuid.UUID("d411de08-9e20-4a6f-8938-bbdfac73d18f")


def persist_thermal(db, job):
    result_id = str(uuid.uuid5(RESULT_NAMESPACE, job.id))
    model = job.request_payload["model"]
    gap = {
        "code": "thermal_model_runtime_unavailable",
        "message": (
            "Расчёт принят с закреплёнными погодными данными и параметрами, "
            "но вычислительный адаптер модели пока недоступен"
        ),
        "required_inputs": [
            job.request_payload["weather_dataset_version_id"],
            job.request_payload["parameter_version_id"],
        ],
        "blocking": True,
    }
    metric_key = "air_temperature_change" if model == "invest_air" else "tmrt_change"
    payload = {
        "id": result_id,
        "scenario_revision_id": job.input_revision_id,
        "kind": model,
        "status": "unavailable",
        "artifact_url": None,
        "metrics": [
            {
                "key": metric_key,
                "value": None,
                "unit": "degC",
                "horizon_year": None,
                "status": "unavailable",
                "lower": None,
                "upper": None,
                "qualitative_confidence": "unknown",
                "method_version": "thermal-data-gate-1",
                "source_refs": [],
                "missing_reason": gap,
            }
        ],
        "data_gaps": [gap],
        "created_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    }
    db.add(
        SpatialResultRecord(
            id=result_id,
            scenario_revision_id=job.input_revision_id,
            city_id=job.city_id,
            job_id=job.id,
            kind=model,
            payload=payload,
            artifact=None,
            created_at=datetime.fromisoformat(payload["created_at"]),
        )
    )
    return result_id
