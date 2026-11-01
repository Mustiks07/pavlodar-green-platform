import json

from shapely.geometry import shape

from tools.dev.demo_bootstrap import (
    DATA,
    DATASETS,
    ECOSYSTEM_COEFFICIENT_KEYS,
    ECOSYSTEM_REQUIRED_KEYS,
    ZONES,
    ecosystem_profile,
    has_complete_mvp_planning,
    has_demo_ecosystem,
    mvp_stock_geojson,
    population_profile_geojson,
    priority_profile_geojson,
)


def test_demo_ecosystem_profile_has_only_supported_sourced_metrics():
    features = ecosystem_profile()["features"]
    properties = [feature["properties"] for feature in features]

    assert len(features) == 7
    assert len({feature["id"] for feature in features}) == len(features)
    assert {item["metric_key"] for item in properties} == ECOSYSTEM_COEFFICIENT_KEYS
    assert all(item["record_type"] == "ecosystem_coefficient" for item in properties)
    assert {item["metric_key"] for item in properties} == {
        "green_area",
        "co2_sequestered",
        "pollutants_removed",
        "oxygen_produced",
        "air_cooling",
        "stormwater_retained",
    }
    assert next(item for item in properties if item["metric_key"] == "air_cooling")[
        "basis"
    ] == "green_fraction"
    assert next(
        item for item in properties if item["metric_key"] == "stormwater_retained"
    )["basis"] == "per_green_m2_year"
    assert {
        item["qualitative_confidence"]
        for item in properties
        if item["metric_key"] in {"air_cooling", "stormwater_retained"}
    } == {"low", "unknown"}
    assert {item["basis"] for item in properties if item["metric_key"] == "green_area"} == {
        "per_tree_year",
        "per_shrub_year",
    }


def test_demo_check_requires_synthetic_values_at_every_horizon():
    complete = {
        "ecosystem": [
            {
                "key": key,
                "horizon_year": horizon,
                "value": 1,
                "status": "synthetic",
            }
            for key in ECOSYSTEM_REQUIRED_KEYS
            for horizon in (5, 10, 20)
        ]
    }
    assert has_demo_ecosystem(complete)

    complete["ecosystem"][0]["value"] = None
    assert not has_demo_ecosystem(complete)
    complete["ecosystem"][0]["value"] = 1
    complete["ecosystem"][0]["status"] = "estimated"
    assert not has_demo_ecosystem(complete)


def test_demo_survival_profile_freezes_explanatory_risks_and_measures():
    profile = json.loads((DATA / DATASETS["demo_models"][2]).read_text(encoding="utf-8"))
    guidance = profile["features"][0]["properties"]["survival_guidance"]

    assert len(guidance) == 5
    assert {item["kind"] for item in guidance} == {"risk", "measure"}
    assert sum(item["kind"] == "risk" for item in guidance) == 3
    assert sum(item["kind"] == "measure" for item in guidance) == 2
    assert all(0 <= item["score"] <= 1 and item["weight"] == 0 for item in guidance)
    assert all(item["factor"] and item["explanation"] for item in guidance)


def test_demo_check_requires_complete_cost_survival_and_twelve_care_operations():
    snapshot = {
        "status": "complete",
        "cost": {"status": "complete", "total": "100.00"},
        "care": [{"id": str(index)} for index in range(12)],
        "survival": [
            {
                "points": [
                    {"year": year, "probability": probability}
                    for year, probability in ((1, 0.9), (2, 0.8), (3, 0.7))
                ]
            }
        ],
    }
    assert has_complete_mvp_planning(snapshot)

    snapshot["care"].pop()
    assert not has_complete_mvp_planning(snapshot)
    snapshot["care"].append({"id": "restored"})
    snapshot["survival"][0]["points"][2]["probability"] = None
    assert not has_complete_mvp_planning(snapshot)


def test_demo_optimizer_inputs_are_explicit_synthetic_and_cover_each_zone():
    city = {
        "boundary": {
            "type": "Polygon",
            "coordinates": [
                [[76.8, 52.1], [77.1, 52.1], [77.1, 52.4], [76.8, 52.4], [76.8, 52.1]]
            ],
        }
    }
    plant_ids = {
        "populus_alba": "00000000-0000-4000-8000-000000000001",
        "pinus_sylvestris": "00000000-0000-4000-8000-000000000002",
        "tilia_cordata": "00000000-0000-4000-8000-000000000003",
        "syringa_vulgaris": "00000000-0000-4000-8000-000000000004",
        "picea_obovata": "00000000-0000-4000-8000-000000000005",
        "salix_sp": "00000000-0000-4000-8000-000000000006",
        "acer_sp": "00000000-0000-4000-8000-000000000007",
        "fraxinus_sp": "00000000-0000-4000-8000-000000000008",
    }
    stock = json.loads(mvp_stock_geojson(city, plant_ids))
    assert len(stock["features"]) == 8
    assert all(item["properties"]["available_quantity"] == 1000 for item in stock["features"])
    assert all(item["properties"]["stock_counted_at"] for item in stock["features"])
    assert all(
        "SYNTHETIC TEST" in item["properties"]["applicability"]
        for item in stock["features"]
    )

    green = json.loads(priority_profile_geojson("green"))["features"]
    soil = json.loads(priority_profile_geojson("soil"))["features"]
    assert len(green) == len(soil) == len(ZONES) == 3
    for green_feature, soil_feature in zip(green, soil, strict=True):
        assert shape(soil_feature["geometry"]).covers(shape(green_feature["geometry"]))
        assert 0 < shape(green_feature["geometry"]).area < shape(soil_feature["geometry"]).area
        assert green_feature["properties"]["profile"].startswith("SYNTHETIC TEST")


def test_demo_population_records_bind_counts_to_exact_zone_ids():
    zones = {
        name: {
            "id": f"zone-{index}",
            "geometry": {"type": "Polygon", "coordinates": [ring + [ring[0]]]},
        }
        for index, (name, _purpose, ring) in enumerate(ZONES, start=1)
    }
    features = json.loads(population_profile_geojson(zones))["features"]

    assert len(features) == 3
    assert {item["properties"]["zone_id"] for item in features} == {
        "zone-1",
        "zone-2",
        "zone-3",
    }
    assert all(item["properties"]["population_count"] > 0 for item in features)
    assert all(item["properties"]["qualitative_confidence"] == "low" for item in features)
    assert all("SYNTHETIC TEST" in item["properties"]["method_note"] for item in features)
