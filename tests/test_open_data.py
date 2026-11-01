import pytest

from tools.data.fetch_pavlodar_osm import (
    ENDPOINTS,
    MAX_FEATURES,
    PROFILES,
    convert_elements,
    query,
)


def test_overpass_query_is_bounded_and_requests_geometry():
    value = query(PROFILES["green"])
    assert "[timeout:180]" in value
    assert "(52.1931974,76.8599921,52.4503782,77.2048261)" in value
    assert "out tags geom" in value
    assert "relation" not in value
    assert all(endpoint.startswith("https://") for endpoint in ENDPOINTS)


def test_overpass_elements_convert_to_contract_geojson_shapes_and_safe_properties():
    road = convert_elements(
        [
            {
                "type": "way",
                "id": 10,
                "tags": {"highway": "residential", "name": "Test", "private": "drop"},
                "geometry": [
                    {"lon": 76.9, "lat": 52.2},
                    {"lon": 76.91, "lat": 52.21},
                ],
            }
        ],
        "line",
    )[0]
    assert road["id"] == "way/10"
    assert road["geometry"]["type"] == "LineString"
    assert road["properties"] == {
        "object_id": "way/10",
        "highway": "residential",
        "name": "Test",
    }
    tree = convert_elements(
        [
            {
                "type": "node",
                "id": 20,
                "lon": 76.95,
                "lat": 52.25,
                "tags": {"natural": "tree"},
            }
        ],
        "point",
    )[0]
    assert tree["geometry"] == {"type": "Point", "coordinates": [76.95, 52.25]}


def test_open_polygon_is_not_promoted_to_green_area_and_limit_is_enforced():
    assert (
        convert_elements(
            [
                {
                    "type": "way",
                    "id": 30,
                    "tags": {"landuse": "grass"},
                    "geometry": [
                        {"lon": 76.9, "lat": 52.2},
                        {"lon": 76.91, "lat": 52.21},
                    ],
                }
            ],
            "polygon",
        )
        == []
    )
    element = {
        "type": "node",
        "id": 1,
        "lon": 76.95,
        "lat": 52.25,
        "tags": {"natural": "tree"},
    }
    with pytest.raises(ValueError, match=str(MAX_FEATURES)):
        convert_elements([{**element, "id": index} for index in range(MAX_FEATURES + 1)], "point")
