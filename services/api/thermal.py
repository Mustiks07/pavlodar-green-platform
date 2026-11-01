"""Validation boundary for data-gated thermal runs."""

from packages.domain.errors import DomainError
from services.api.coefficients import authorize_coefficient
from services.api.models import Dataset, DatasetVersion, Scenario


def validate_thermal_request(db, access, revision, body):
    frozen = set(revision.payload["dataset_version_ids"])
    weather = db.get(DatasetVersion, body["weather_dataset_version_id"])
    if weather is None or weather.status != "published":
        raise DomainError(422, "thermal_inputs_unavailable", "Weather input is not published")
    dataset = db.get(Dataset, weather.dataset_id)
    access.dataset(dataset)
    if dataset.payload["kind"] != "weather" or weather.id not in frozen:
        raise DomainError(
            422,
            "thermal_inputs_unavailable",
            "Thermal weather input must be a frozen published weather dataset",
        )
    scenario_city_id = db.get(Scenario, revision.scenario_id).city_id
    if dataset.city_id != scenario_city_id:
        raise DomainError(422, "thermal_inputs_unavailable", "Weather input belongs to another city")
    parameter = authorize_coefficient(
        db,
        access,
        body["parameter_version_id"],
        city_id=scenario_city_id,
        usable=True,
    )
    if parameter.dataset_version_id not in frozen:
        raise DomainError(
            422,
            "thermal_inputs_unavailable",
            "Thermal parameter source must be frozen in the scenario revision",
        )
    return weather, parameter
