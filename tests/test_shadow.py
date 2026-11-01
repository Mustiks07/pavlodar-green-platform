"""Scientific checks of shadow-analytic-1 on references with known answers (no database)."""

import math
from datetime import UTC, datetime, timedelta, timezone

import pytest
import shapely
from shapely.geometry import Point, Polygon, box

from packages.domain.errors import DomainError
from packages.domain.shadow import (
    MAX_SHADOW_LENGTH_M,
    Building,
    ShadowInputs,
    SunPosition,
    Tree,
    compute_shadows,
    crown_shadow,
    prism_shadow,
    solar_position,
)

PAVLODAR = (52.29, 76.95)


def sun(elevation, azimuth):
    return SunPosition(
        elevation_deg=elevation, azimuth_deg=azimuth, declination_deg=0.0, equation_of_time_min=0.0
    )


def test_nrel_spa_reference_vector():
    # Reda & Andreas (2003), NREL/TP-560-34302, example: topocentric zenith 50.11162 deg,
    # azimuth 194.34024 deg. NOAA equations are expected within a few hundredths of a degree.
    s = solar_position(
        datetime(2003, 10, 17, 12, 30, 30, tzinfo=timezone(timedelta(hours=-7))),
        39.742476,
        -105.1786,
    )
    assert 90 - s.elevation_deg == pytest.approx(50.11162, abs=0.02)
    assert s.azimuth_deg == pytest.approx(194.34024, abs=0.02)


def solar_noon(day, lon):
    guess = datetime(day.year, day.month, day.day, 12, tzinfo=UTC) - timedelta(minutes=4 * lon)
    eq = solar_position(guess, 0.0, lon).equation_of_time_min
    return guess - timedelta(minutes=eq)


def test_solar_noon_elevation_and_azimuth_at_pavlodar_solstice():
    lat, lon = PAVLODAR
    noon = solar_noon(datetime(2026, 6, 21), lon)
    s = solar_position(noon, lat, lon)
    # Upper culmination: elevation = 90 - (lat - declination), plus ~0.01 deg refraction.
    assert s.azimuth_deg == pytest.approx(180.0, abs=0.05)
    assert s.elevation_deg == pytest.approx(90 - (lat - s.declination_deg), abs=0.03)
    assert s.declination_deg == pytest.approx(23.44, abs=0.01)


def test_morning_east_afternoon_west_and_symmetry():
    lat, lon = PAVLODAR
    noon = solar_noon(datetime(2026, 9, 1), lon)
    am, pm = (
        solar_position(noon - timedelta(hours=3), lat, lon),
        solar_position(noon + timedelta(hours=3), lat, lon),
    )
    assert am.azimuth_deg < 180 < pm.azimuth_deg
    assert am.azimuth_deg + pm.azimuth_deg == pytest.approx(360.0, abs=0.3)
    assert am.elevation_deg == pytest.approx(pm.elevation_deg, abs=0.1)


def test_night_has_no_sun():
    lat, lon = PAVLODAR
    noon = solar_noon(datetime(2026, 12, 21), lon)
    assert solar_position(noon + timedelta(hours=12), lat, lon).elevation_deg < 0


def test_naive_datetime_rejected():
    with pytest.raises(DomainError) as e:
        solar_position(datetime(2026, 6, 21, 12), *PAVLODAR)
    assert e.value.code == "shadow_datetime_naive"


@pytest.mark.parametrize(
    ("elevation", "length"),
    [(45.0, 10.0), (30.0, 10 / math.tan(math.radians(30))), (60.0, 10 / math.sqrt(3))],
)
def test_cube_shadow_with_sun_from_south(elevation, length):
    # 10 m cube, sun due south: the shadow runs north and adds length x 10 m to the footprint.
    shadow = prism_shadow(box(0, 0, 10, 10), 10.0, sun(elevation, 180.0))
    assert shadow.area == pytest.approx(100 + 10 * length, rel=1e-9)
    minx, miny, maxx, maxy = shadow.bounds
    assert (minx, miny, maxx) == pytest.approx((0, 0, 10))
    assert maxy == pytest.approx(10 + length)


def test_cube_shadow_with_diagonal_sun():
    # Sun from the south-east (135 deg): Minkowski sum area = A + L * (projected width 10*(sin+cos)).
    shadow = prism_shadow(box(0, 0, 10, 10), 10.0, sun(45.0, 135.0))
    assert shadow.area == pytest.approx(100 + 10 * 10 * math.sqrt(2), rel=1e-9)
    assert shadow.bounds == pytest.approx((-10 / math.sqrt(2), 0, 10, 10 + 10 / math.sqrt(2)))


def brute_force_area(footprint, d, bounds, step=0.25):
    """Independent definition: q is shaded iff the segment q -> q - d touches the footprint."""
    minx, miny, maxx, maxy = bounds
    shapely.prepare(footprint)
    hits = 0
    y = miny + step / 2
    while y < maxy:
        x = minx + step / 2
        while x < maxx:
            seg = shapely.LineString([(x, y), (x - d[0], y - d[1])])
            hits += footprint.intersects(seg)
            x += step
        y += step
    return hits * step * step


def test_non_convex_footprint_with_courtyard_matches_brute_force():
    outer = Polygon(
        [(0, 0), (30, 0), (30, 30), (0, 30)], holes=[[(10, 10), (20, 10), (20, 20), (10, 20)]]
    )
    l_shape = outer.difference(box(20, 20, 30, 30))
    s = sun(35.0, 200.0)
    shadow = prism_shadow(l_shape, 12.0, s)
    a = math.radians(s.azimuth_deg)
    length = 12.0 / math.tan(math.radians(s.elevation_deg))
    d = (-math.sin(a) * length, -math.cos(a) * length)
    reference = brute_force_area(l_shape, d, shadow.buffer(1).bounds)
    assert shadow.area == pytest.approx(reference, rel=0.01)
    # At 35 deg the 17 m shadow is longer than the 10 m courtyard: the courtyard is fully shaded.
    assert shadow.contains(Point(15, 19))
    # A high sun (60 deg, 6.9 m shadow) shades only the courtyard's southern part.
    high = prism_shadow(l_shape, 12.0, sun(60.0, 200.0))
    assert high.contains(Point(15, 11)) and not high.contains(Point(15, 19))


def test_crown_ellipse_area_and_offset():
    s = sun(40.0, 180.0)
    shadow = crown_shadow(0.0, 0.0, 8.0, 2.0, s)
    assert shadow.area == pytest.approx(math.pi * 4 / math.sin(math.radians(40)), rel=0.005)
    # Centre of the crown is 6 m high: the ellipse centre lies 6 / tan(40) m north of the trunk.
    assert shadow.centroid.y == pytest.approx(6 / math.tan(math.radians(40)), abs=0.01)
    assert shadow.centroid.x == pytest.approx(0.0, abs=1e-6)


def test_zone_shade_exact_and_grid_agree():
    zone = box(0, 10, 40, 40)  # north of the building
    building = Building("b1", box(0, 0, 10, 10), 10.0, "measured")
    out = compute_shadows(
        ShadowInputs(zone, [building], [], "analytical_verified", 0.5), sun(45.0, 180.0)
    )
    assert out.shaded_open_ground_m2 == pytest.approx(100.0, rel=1e-9)  # 10 x 10 band north of it
    grid_area = out.grid["shaded_cells"] * 0.25
    assert grid_area == pytest.approx(out.shaded_open_ground_m2, abs=0.5 * 40)
    assert out.used_buildings == ["b1"]


def test_neighbor_outside_zone_casts_into_zone_and_far_one_is_ignored():
    zone = box(0, 20, 20, 40)
    near = Building(
        "near", box(0, 0, 20, 10), 20.0, "measured"
    )  # shadow 20 m north reaches the zone
    far = Building("far", box(500, -900, 510, -890), 20.0, "measured")
    out = compute_shadows(
        ShadowInputs(zone, [near, far], [], "analytical_verified", 1.0), sun(45.0, 180.0)
    )
    assert out.shaded_open_ground_m2 == pytest.approx(20 * 10)
    assert out.used_buildings == ["near"]


def test_unknown_or_unaccepted_heights_are_excluded_not_invented():
    zone = box(0, 10, 40, 40)
    inputs = [
        Building("unknown", box(0, 0, 10, 10), None, "unknown"),
        Building("osm", box(12, 0, 20, 8), 15.0, "recorded_unverified"),
        Building("placeholder", box(22, 0, 30, 8), 9.0, "visual_placeholder"),
        Building("bad", Polygon([(0, 0), (5, 5), (5, 0), (0, 5)]), 10.0, "measured"),
    ]
    strict = compute_shadows(
        ShadowInputs(zone, inputs, [], "analytical_verified", 1.0), sun(45.0, 180.0)
    )
    assert strict.shaded_open_ground_m2 == 0
    assert strict.excluded == {
        "height_unknown": ["unknown"],
        "height_basis_not_allowed": ["osm", "placeholder"],
        "footprint_invalid": ["bad"],
    }
    preview = compute_shadows(
        ShadowInputs(zone, inputs, [], "estimated_preview", 1.0), sun(45.0, 180.0)
    )
    assert preview.used_buildings == ["osm"]
    assert preview.shaded_open_ground_m2 > 0


def test_trees_need_both_dimensions_and_an_accepted_basis():
    zone = box(-20, -20, 20, 20)
    trees = [
        Tree("t-ok", 0, 0, 6.0, 1.5, "measured"),
        Tree("t-no-crown", 5, 5, 6.0, None, "measured"),
        Tree("t-catalog", -5, -5, 6.0, 1.5, "catalog"),
    ]
    out = compute_shadows(
        ShadowInputs(zone, [], trees, "analytical_verified", 0.5), sun(50.0, 180.0)
    )
    assert out.used_trees == ["t-ok"]
    assert out.excluded == {
        "dimensions_unknown": ["t-no-crown"],
        "dimension_basis_not_allowed": ["t-catalog"],
    }


def test_invalid_zone_and_oversized_grid_are_rejected():
    bowtie = Polygon([(0, 0), (10, 10), (10, 0), (0, 10)])
    with pytest.raises(DomainError) as e:
        compute_shadows(ShadowInputs(bowtie, [], [], "analytical_verified", 1.0), sun(45, 180))
    assert e.value.code == "shadow_zone_invalid"
    with pytest.raises(DomainError) as e:
        compute_shadows(
            ShadowInputs(box(0, 0, 5000, 5000), [], [], "analytical_verified", 0.25), sun(45, 180)
        )
    assert e.value.code == "shadow_grid_too_large"


def test_sun_below_horizon_is_an_explicit_error():
    with pytest.raises(DomainError) as e:
        compute_shadows(
            ShadowInputs(box(0, 0, 10, 10), [], [], "analytical_verified", 1.0), sun(-3.0, 0.0)
        )
    assert e.value.code == "sun_below_horizon"


def test_very_low_sun_is_capped_and_reported():
    out = compute_shadows(
        ShadowInputs(
            box(0, 10, 50, 600),
            [Building("b", box(0, 0, 10, 10), 30.0, "measured")],
            [],
            "analytical_verified",
            2.0,
        ),
        sun(2.0, 180.0),
    )
    assert out.capped
    assert out.shadow.bounds[3] == pytest.approx(10 + MAX_SHADOW_LENGTH_M)


def test_checkpoint_can_cancel():
    class Cancelled(Exception):
        pass

    def stop(progress):
        if progress > 0.3:
            raise Cancelled

    with pytest.raises(Cancelled):
        compute_shadows(
            ShadowInputs(box(0, 0, 50, 50), [], [], "analytical_verified", 1.0), sun(45, 180), stop
        )
