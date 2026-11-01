import pytest

from packages.domain.errors import DomainError
from services.api.catalog import _validate_crown_clearance


def placement(longitude, radius, basis="measured"):
    return {
        "position": {"type": "Point", "coordinates": [longitude, 52.28]},
        "initial_crown_radius_m": radius,
        "dimension_basis": basis,
    }


def test_known_crown_overlap_reports_both_positions():
    with pytest.raises(DomainError) as raised:
        _validate_crown_clearance(
            {"placements": [placement(76.98, 2.0), placement(76.98001, 2.0)]}
        )
    assert raised.value.code == "placement_spacing_conflict"
    assert [item["path"] for item in raised.value.field_errors] == [
        "/placements/0/position",
        "/placements/1/position",
    ]


def test_unknown_radius_never_blocks_and_clear_known_crowns_pass():
    _validate_crown_clearance(
        {
            "placements": [
                placement(76.98, None, "unknown"),
                placement(76.98, 2.0),
                placement(76.981, 2.0),
            ]
        }
    )
