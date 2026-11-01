"""Analytical ground shadows for one instant (method shadow-analytic-1).

Model, stated so results can be reviewed:
- Sun: NOAA solar position equations (Meeus-based), UT time, apparent elevation with the NOAA
  standard-atmosphere refraction correction. Azimuth is clockwise from geographic north.
- Ground: a horizontal plane at the base of every object. No terrain, no reflections, no light
  transmission through crowns.
- Buildings: vertical prisms over their footprint with the server-recorded height. The ground
  shadow is the Minkowski sum of the footprint with the horizontal shadow vector, built exactly
  from the footprint, its translate and one quadrilateral per boundary edge.
- Planted trees: an opaque sphere of the stated crown radius whose top is at the stated height;
  its ground shadow is an ellipse (minor semi-axis r, major semi-axis r / sin(elevation)).
  Trunks are ignored.
- Objects without a usable height (or crown radius) are excluded and reported. Nothing is
  extruded from a default or guessed value.

All geometry is in a metric projected CRS (metres). The functions here are pure; the worker
loads inputs, projects coordinates and persists the result.
"""

import itertools
import math
from dataclasses import dataclass, field
from datetime import UTC, datetime

import numpy as np
import shapely
from shapely import affinity
from shapely.geometry import MultiPolygon, Point, Polygon
from shapely.geometry.base import BaseGeometry

from packages.domain.errors import DomainError

METHOD_VERSION = "shadow-analytic-1"
# Bounds that keep a run inside the worker time limit and reject nonsense inputs early.
MAX_GRID_CELLS = 2_000_000
MAX_SHADOW_LENGTH_M = 500.0
MAX_BUILDING_HEIGHT_M = 400.0
MAX_TREE_HEIGHT_M = 60.0
MAX_CROWN_RADIUS_M = 20.0
MIN_FOOTPRINT_M2 = 1.0
MAX_FOOTPRINT_M2 = 500_000.0
ELLIPSE_SEGMENTS = 64

# Height bases accepted per geometry mode (ShadowRequest.geometry_mode).
BUILDING_BASES = {
    "analytical_verified": frozenset({"measured"}),
    "estimated_preview": frozenset({"measured", "recorded_unverified", "floors_estimate"}),
}
TREE_BASES = {
    "analytical_verified": frozenset({"measured"}),
    "estimated_preview": frozenset({"measured", "catalog", "estimated"}),
}


@dataclass(frozen=True)
class SunPosition:
    elevation_deg: float
    azimuth_deg: float
    declination_deg: float
    equation_of_time_min: float


def julian_day(when: datetime) -> float:
    if when.tzinfo is None:
        raise DomainError(422, "shadow_datetime_naive", "Shadow datetime needs an explicit offset")
    return when.astimezone(UTC).timestamp() / 86400.0 + 2440587.5


def refraction_deg(geometric_elevation_deg: float) -> float:
    """NOAA approximation of atmospheric refraction for a standard atmosphere, in degrees."""
    e = geometric_elevation_deg
    if e > 85.0:
        return 0.0
    te = math.tan(math.radians(e))
    if e > 5.0:
        arcsec = 58.1 / te - 0.07 / te**3 + 0.000086 / te**5
    elif e > -0.575:
        arcsec = 1735.0 + e * (-518.2 + e * (103.4 + e * (-12.79 + e * 0.711)))
    else:
        arcsec = -20.774 / te
    return arcsec / 3600.0


def solar_position(when: datetime, lat_deg: float, lon_deg: float) -> SunPosition:
    """Apparent solar elevation and azimuth (NOAA solar calculator equations)."""
    if not (-90.0 <= lat_deg <= 90.0 and -180.0 <= lon_deg <= 180.0):
        raise DomainError(422, "shadow_location_invalid", "Latitude/longitude out of range")
    jd = julian_day(when)
    t = (jd - 2451545.0) / 36525.0
    l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360.0
    m = 357.52911 + t * (35999.05029 - 0.0001537 * t)
    ecc = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
    mr = math.radians(m)
    center = (
        math.sin(mr) * (1.914602 - t * (0.004817 + 0.000014 * t))
        + math.sin(2 * mr) * (0.019993 - 0.000101 * t)
        + math.sin(3 * mr) * 0.000289
    )
    omega = math.radians(125.04 - 1934.136 * t)
    apparent_long = math.radians(l0 + center - 0.00569 - 0.00478 * math.sin(omega))
    eps0 = 23.0 + (26.0 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60.0) / 60.0
    eps = math.radians(eps0 + 0.00256 * math.cos(omega))
    decl = math.asin(math.sin(eps) * math.sin(apparent_long))
    y = math.tan(eps / 2) ** 2
    l0r = math.radians(l0)
    eq_time = 4.0 * math.degrees(
        y * math.sin(2 * l0r)
        - 2 * ecc * math.sin(mr)
        + 4 * ecc * y * math.sin(mr) * math.cos(2 * l0r)
        - 0.5 * y * y * math.sin(4 * l0r)
        - 1.25 * ecc * ecc * math.sin(2 * mr)
    )
    utc = when.astimezone(UTC)
    minutes = utc.hour * 60 + utc.minute + (utc.second + utc.microsecond / 1e6) / 60.0
    true_solar = (minutes + eq_time + 4.0 * lon_deg) % 1440.0
    hour_angle = math.radians(true_solar / 4.0 - 180.0)
    lat = math.radians(lat_deg)
    cos_zenith = math.sin(lat) * math.sin(decl) + math.cos(lat) * math.cos(decl) * math.cos(
        hour_angle
    )
    zenith = math.acos(max(-1.0, min(1.0, cos_zenith)))
    geometric = 90.0 - math.degrees(zenith)
    azimuth = (
        math.degrees(
            math.atan2(
                math.sin(hour_angle),
                math.cos(hour_angle) * math.sin(lat) - math.tan(decl) * math.cos(lat),
            )
        )
        + 180.0
    ) % 360.0
    return SunPosition(
        elevation_deg=geometric + refraction_deg(geometric),
        azimuth_deg=azimuth,
        declination_deg=math.degrees(decl),
        equation_of_time_min=eq_time,
    )


def shadow_direction(sun: SunPosition) -> tuple[float, float]:
    """Unit horizontal vector (east, north) pointing away from the sun."""
    a = math.radians(sun.azimuth_deg)
    return (-math.sin(a), -math.cos(a))


def shadow_length(height_m: float, sun: SunPosition) -> float:
    if sun.elevation_deg <= 0:
        raise DomainError(422, "sun_below_horizon", "The sun is below the horizon")
    return height_m / math.tan(math.radians(sun.elevation_deg))


def prism_shadow(footprint: Polygon, height_m: float, sun: SunPosition) -> BaseGeometry:
    """Ground shadow of a vertical prism, including its own footprint (exact polygon)."""
    length = min(shadow_length(height_m, sun), MAX_SHADOW_LENGTH_M)
    ux, uy = shadow_direction(sun)
    dx, dy = ux * length, uy * length
    parts = [footprint, affinity.translate(footprint, dx, dy)]
    for ring in [footprint.exterior, *footprint.interiors]:
        for (ax, ay), (bx, by) in itertools.pairwise(ring.coords):
            quad = Polygon([(ax, ay), (bx, by), (bx + dx, by + dy), (ax + dx, ay + dy)])
            if quad.area > 0:
                parts.append(quad)
    return shapely.union_all(parts)


def crown_shadow(
    x: float, y: float, height_m: float, crown_radius_m: float, sun: SunPosition
) -> Polygon:
    """Ground shadow (ellipse) of a spherical crown whose top is at height_m above the base."""
    elevation = math.radians(sun.elevation_deg)
    center_height = max(height_m - crown_radius_m, 0.0)
    offset = min(shadow_length(center_height, sun), MAX_SHADOW_LENGTH_M) if center_height else 0.0
    ux, uy = shadow_direction(sun)
    major = min(crown_radius_m / math.sin(elevation), MAX_SHADOW_LENGTH_M)
    circle = Point(0.0, 0.0).buffer(1.0, quad_segs=ELLIPSE_SEGMENTS // 4)
    # Unit circle -> ellipse with the major axis along +x, then rotate onto the shadow direction.
    ellipse = affinity.scale(circle, major, crown_radius_m, origin=(0, 0))
    ellipse = affinity.rotate(ellipse, math.atan2(uy, ux), origin=(0, 0), use_radians=True)
    return affinity.translate(ellipse, x + ux * offset, y + uy * offset)


@dataclass
class Building:
    source_record_id: str
    footprint: BaseGeometry
    height_m: float | None
    height_basis: str


@dataclass
class Tree:
    placement_id: str
    x: float
    y: float
    height_m: float | None
    crown_radius_m: float | None
    dimension_basis: str
    quantity: int = 1


@dataclass
class ShadowInputs:
    zone: BaseGeometry
    buildings: list[Building]
    trees: list[Tree]
    geometry_mode: str
    grid_resolution_m: float


@dataclass
class ShadowOutcome:
    sun: SunPosition
    shadow: BaseGeometry
    zone_area_m2: float
    open_ground_m2: float
    shaded_open_ground_m2: float
    grid: dict
    used_buildings: list[str] = field(default_factory=list)
    used_trees: list[str] = field(default_factory=list)
    excluded: dict[str, list[str]] = field(default_factory=dict)
    capped: bool = False


def check_zone(zone: BaseGeometry, resolution_m: float) -> None:
    if not isinstance(zone, (Polygon, MultiPolygon)) or zone.is_empty:
        raise DomainError(422, "shadow_zone_invalid", "Zone geometry must be a polygon")
    if not zone.is_valid:
        raise DomainError(
            422,
            "shadow_zone_invalid",
            "Zone geometry is not valid: " + shapely.is_valid_reason(zone),
        )
    if not (0.25 <= resolution_m <= 10.0):
        raise DomainError(422, "shadow_grid_invalid", "grid_resolution_m must be within 0.25..10 m")
    minx, miny, maxx, maxy = zone.bounds
    cells = math.ceil((maxx - minx) / resolution_m) * math.ceil((maxy - miny) / resolution_m)
    if cells > MAX_GRID_CELLS:
        raise DomainError(
            422,
            "shadow_grid_too_large",
            f"Grid of {cells} cells exceeds {MAX_GRID_CELLS}; use a coarser grid_resolution_m",
        )


def usable_building(b: Building, mode: str) -> str | None:
    """Reason a building cannot cast a shadow in this mode, or None when it can."""
    if b.height_m is None or b.height_basis == "unknown":
        return "height_unknown"
    if b.height_basis not in BUILDING_BASES[mode]:
        return "height_basis_not_allowed"
    if not math.isfinite(b.height_m) or not (0 < b.height_m <= MAX_BUILDING_HEIGHT_M):
        return "height_out_of_range"
    if not isinstance(b.footprint, Polygon) or b.footprint.is_empty:
        return "footprint_not_polygon"
    if not b.footprint.is_valid:
        return "footprint_invalid"
    if not (MIN_FOOTPRINT_M2 <= b.footprint.area <= MAX_FOOTPRINT_M2):
        return "footprint_area_out_of_range"
    return None


def usable_tree(tr: Tree, mode: str) -> str | None:
    if tr.height_m is None or tr.crown_radius_m is None or tr.dimension_basis == "unknown":
        return "dimensions_unknown"
    if tr.dimension_basis not in TREE_BASES[mode]:
        return "dimension_basis_not_allowed"
    if not (0 < tr.height_m <= MAX_TREE_HEIGHT_M and 0 < tr.crown_radius_m <= MAX_CROWN_RADIUS_M):
        return "dimensions_out_of_range"
    if not (math.isfinite(tr.x) and math.isfinite(tr.y)):
        return "position_invalid"
    return None


def neighbor_buffer_m(buildings: list[Building], sun: SunPosition) -> float:
    """Distance from the zone within which a building can shade it (bounded)."""
    tallest = max((b.height_m or 0.0 for b in buildings), default=0.0)
    return min(shadow_length(tallest, sun), MAX_SHADOW_LENGTH_M) if tallest > 0 else 0.0


def compute_shadows(
    inputs: ShadowInputs, sun: SunPosition, checkpoint=lambda progress: None
) -> ShadowOutcome:
    """Shadow union, exact shaded area of open zone ground and a cell grid for the artifact.

    checkpoint(progress) is called between stages and grid rows; it may raise to cancel.
    """
    if inputs.geometry_mode not in BUILDING_BASES:
        raise DomainError(422, "shadow_mode_invalid", "Unknown geometry_mode")
    check_zone(inputs.zone, inputs.grid_resolution_m)
    if sun.elevation_deg <= 0:
        raise DomainError(422, "sun_below_horizon", "The sun is below the horizon at this time")

    excluded: dict[str, list[str]] = {}
    capped = False
    reach = inputs.zone.buffer(neighbor_buffer_m(inputs.buildings, sun))
    parts, footprints, used_b, used_t = [], [], [], []
    for b in inputs.buildings:
        reason = usable_building(b, inputs.geometry_mode)
        if reason:
            excluded.setdefault(reason, []).append(b.source_record_id)
            continue
        if not b.footprint.intersects(reach):
            continue
        capped |= shadow_length(b.height_m, sun) > MAX_SHADOW_LENGTH_M
        parts.append(prism_shadow(b.footprint, b.height_m, sun))
        footprints.append(b.footprint)
        used_b.append(b.source_record_id)
    checkpoint(0.2)
    for tr in inputs.trees:
        reason = usable_tree(tr, inputs.geometry_mode)
        if reason:
            excluded.setdefault(reason, []).append(tr.placement_id)
            continue
        parts.append(crown_shadow(tr.x, tr.y, tr.height_m, tr.crown_radius_m, sun))
        used_t.append(tr.placement_id)
    checkpoint(0.4)

    shadow = shapely.union_all(parts) if parts else Polygon()
    open_ground = (
        inputs.zone.difference(shapely.union_all(footprints)) if footprints else inputs.zone
    )
    shaded = open_ground.intersection(shadow) if parts else Polygon()
    grid = rasterize(open_ground, shadow, inputs.grid_resolution_m, checkpoint)
    return ShadowOutcome(
        sun=sun,
        shadow=shadow,
        zone_area_m2=inputs.zone.area,
        open_ground_m2=open_ground.area,
        shaded_open_ground_m2=shaded.area,
        grid=grid,
        used_buildings=used_b,
        used_trees=used_t,
        excluded=excluded,
        capped=capped,
    )


def rasterize(
    open_ground: BaseGeometry, shadow: BaseGeometry, resolution_m: float, checkpoint
) -> dict:
    """Cell-centre sampling: 1 shaded, 0 sunlit, null outside open ground. Row 0 is the north row."""
    minx, miny, maxx, maxy = open_ground.bounds if not open_ground.is_empty else (0, 0, 0, 0)
    cols = max(1, math.ceil((maxx - minx) / resolution_m))
    rows = max(1, math.ceil((maxy - miny) / resolution_m))
    shapely.prepare(open_ground)
    if not shadow.is_empty:
        shapely.prepare(shadow)
    xs = minx + (np.arange(cols) + 0.5) * resolution_m
    values, shaded_cells, ground_cells = [], 0, 0
    chunk = max(1, rows // 20)
    for r in range(rows):
        y = maxy - (r + 0.5) * resolution_m
        ys = np.full(cols, y)
        inside = shapely.contains_xy(open_ground, xs, ys)
        dark = (
            shapely.contains_xy(shadow, xs, ys)
            if not shadow.is_empty
            else np.zeros(cols, dtype=bool)
        )
        row = [None if not i else (1 if d else 0) for i, d in zip(inside, dark, strict=True)]
        ground_cells += int(inside.sum())
        shaded_cells += int((inside & dark).sum())
        values.append(row)
        if r % chunk == 0:
            checkpoint(0.4 + 0.5 * r / rows)
    return {
        "origin": [minx, maxy],
        "resolution_m": resolution_m,
        "rows": rows,
        "cols": cols,
        "values": values,
        "ground_cells": ground_cells,
        "shaded_cells": shaded_cells,
    }
