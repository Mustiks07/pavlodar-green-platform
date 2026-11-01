from types import SimpleNamespace

import pytest

from packages.domain.contracts import validate
from services.api.ecosystem import ecosystem_metrics
from services.api.models import (
    CoefficientVersionRecord,
    DatasetVersion,
    ImportRecord,
    PlantVersion,
    ZoneVersion,
)

VERSION_ID = "11111111-1111-4111-8111-111111111111"
COEFFICIENT_ID = "22222222-2222-4222-8222-222222222222"
ZONE_VERSION_ID = "33333333-3333-4333-8333-333333333333"
CATALOG_VERSION_ID = "44444444-4444-4444-8444-444444444444"
PLANT_ID = "55555555-5555-4555-8555-555555555555"
POPULATION_VERSION_ID = "77777777-7777-4777-8777-777777777777"


class ScalarRows:
    def __init__(self, rows):
        self.rows = rows

    def all(self):
        return self.rows


class FakeDb:
    def __init__(self, objects, scalar_batches):
        self.objects = objects
        self.scalar_batches = list(scalar_batches)

    def get(self, model, identity):
        return self.objects.get((model, identity))

    def scalars(self, _query):
        return ScalarRows(self.scalar_batches.pop(0))


def source_ref(source_record_id):
    return {
        "dataset_version_id": VERSION_ID,
        "source_record_id": source_record_id,
        "label": "SYNTHETIC TEST ecosystem profile",
        "uri": None,
    }


def record(index, source_record_id, **properties):
    return ImportRecord(
        version_id=VERSION_ID,
        row_index=index,
        payload={
            "source_record_id": source_record_id,
            "geometry": {"type": "Point", "coordinates": [76.98, 52.28]},
            "properties": {"record_type": "ecosystem_coefficient", **properties},
        },
    )


def test_source_profile_uses_green_area_before_area_based_flows():
    rows = [
        record(
            0,
            "green",
            metric_key="green_area",
            value="10",
            unit="m2",
            basis="per_tree_year",
            horizon_factors={"5": "0.5", "10": "1", "20": "2"},
            qualitative_confidence="low",
        ),
        record(
            1,
            "co2",
            metric_key="co2_sequestered",
            value="0.001",
            unit="t_CO2_per_year",
            basis="per_green_m2_year",
        ),
        record(
            2,
            "air",
            metric_key="air_cooling",
            value="2",
            unit="degC",
            basis="green_fraction",
            qualitative_confidence="low",
        ),
        record(
            3,
            "storm",
            metric_key="stormwater_retained",
            value="0.1",
            unit="m3",
            basis="per_green_m2_year",
            qualitative_confidence="unknown",
        ),
        record(
            4,
            "oxygen",
            metric_key="oxygen_produced",
            value="2",
            unit="kg_per_year",
            basis="per_tree_year",
        ),
        record(
            5,
            "invalid",
            metric_key="pollutants_removed",
            value="NaN",
            unit="kg_per_year",
            basis="per_tree_year",
        ),
    ]
    refs = [source_ref(item.payload["source_record_id"]) for item in rows]
    version = DatasetVersion(
        id=VERSION_ID,
        dataset_id="66666666-6666-4666-8666-666666666666",
        status="published",
        payload={},
        synthetic=True,
    )
    coefficient = CoefficientVersionRecord(
        id=COEFFICIENT_ID,
        dataset_version_id=VERSION_ID,
        payload={"source_refs": refs},
    )
    zone = ZoneVersion(id=ZONE_VERSION_ID, payload={"area_m2": 1000})
    plant = PlantVersion(
        catalog_version_id=CATALOG_VERSION_ID,
        plant_id=PLANT_ID,
        payload={"stratum": "tree"},
    )
    revision = SimpleNamespace(
        zone_version_id=ZONE_VERSION_ID,
        payload={
            "coefficient_version_id": COEFFICIENT_ID,
            "catalog_version_id": CATALOG_VERSION_ID,
            "dataset_version_ids": [POPULATION_VERSION_ID],
            "placements": [{"plant_id": PLANT_ID, "quantity": 3}],
        },
    )
    population_version = DatasetVersion(
        id=POPULATION_VERSION_ID,
        dataset_id="88888888-8888-4888-8888-888888888888",
        status="published",
        payload={},
        synthetic=True,
    )
    population = ImportRecord(
        version_id=POPULATION_VERSION_ID,
        row_index=0,
        payload={
            "source_record_id": "population-zone",
            "geometry": {"type": "Point", "coordinates": [76.98, 52.28]},
            "properties": {
                "record_type": "population_input",
                "zone_id": "zone-1",
                "population_count": 120,
                "qualitative_confidence": "low",
                "source_label": "SYNTHETIC TEST population",
            },
        },
    )
    zone.zone_id = "zone-1"
    db = FakeDb(
        {
            (CoefficientVersionRecord, COEFFICIENT_ID): coefficient,
            (DatasetVersion, VERSION_ID): version,
            (DatasetVersion, POPULATION_VERSION_ID): population_version,
            (ZoneVersion, ZONE_VERSION_ID): zone,
        },
        [rows, [plant], [population]],
    )

    metrics = ecosystem_metrics(db, revision)
    assert len(metrics) == 21
    for metric in metrics:
        validate("Metric", metric)
    indexed = {(item["key"], item["horizon_year"]): item for item in metrics}

    assert indexed[("green_area", 5)]["value"] == pytest.approx(15)
    assert indexed[("green_area", 10)]["value"] == pytest.approx(30)
    assert indexed[("green_area", 20)]["value"] == pytest.approx(60)
    assert indexed[("co2_sequestered", 5)]["value"] == pytest.approx(0.015)
    assert indexed[("stormwater_retained", 20)]["value"] == pytest.approx(6)
    assert indexed[("oxygen_produced", 10)]["value"] == pytest.approx(6)
    assert indexed[("air_cooling", 10)]["value"] == pytest.approx(0.06)
    assert indexed[("air_cooling", 10)]["qualitative_confidence"] == "low"
    assert indexed[("stormwater_retained", 10)]["qualitative_confidence"] == "unknown"
    assert indexed[("pollutants_removed", 10)]["status"] == "unavailable"
    assert indexed[("green_area_per_person", 10)]["value"] == pytest.approx(0.25)
    assert indexed[("green_area_per_person", 10)]["qualitative_confidence"] == "low"
    assert {
        ref["source_record_id"]
        for ref in indexed[("green_area_per_person", 10)]["source_refs"]
    } == {"green", "population-zone"}
    assert indexed[("co2_sequestered", 10)]["status"] == "synthetic"
    assert {ref["source_record_id"] for ref in indexed[("co2_sequestered", 10)]["source_refs"]} == {
        "co2",
        "green",
    }


def test_missing_profile_preserves_all_unavailable_indicators():
    revision = SimpleNamespace(
        zone_version_id=ZONE_VERSION_ID,
        payload={"coefficient_version_id": None},
    )
    metrics = ecosystem_metrics(FakeDb({}, []), revision)

    assert len(metrics) == 21
    assert all(item["status"] == "unavailable" for item in metrics)
    assert {item["missing_reason"]["code"] for item in metrics} == {
        "ecosystem_coefficient_unavailable"
    }
