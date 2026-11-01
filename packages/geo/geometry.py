import math

from pyproj import Transformer
from shapely.geometry import shape
from shapely.ops import transform

from packages.domain.errors import DomainError

PROJECT = Transformer.from_crs("EPSG:4326", "EPSG:32643", always_xy=True).transform


def area_geometry(value):
    """Reject malformed input before Shapely can silently close an open ring."""
    polygons = [value["coordinates"]] if value["type"] == "Polygon" else value["coordinates"]
    if sum(len(r) for p in polygons for r in p) > 10000:
        raise DomainError(
            422,
            "geometry_too_complex",
            "Maximum 10000 vertices per zone",
            field_errors=[
                {
                    "path": "/geometry/coordinates",
                    "code": "geometry_too_complex",
                    "message": "Контур содержит больше 10000 вершин",
                }
            ],
        )
    for polygon in polygons:
        for ring in polygon:
            if ring[0] != ring[-1]:
                raise DomainError(
                    422,
                    "open_ring",
                    "Polygon rings must be explicitly closed",
                    field_errors=[
                        {
                            "path": "/geometry/coordinates",
                            "code": "open_ring",
                            "message": "Первая и последняя точки контура должны совпадать",
                        }
                    ],
                )
            for lon, lat in ring:
                if (
                    not math.isfinite(lon)
                    or not math.isfinite(lat)
                    or not (-180 <= lon <= 180 and -90 <= lat <= 90)
                ):
                    raise DomainError(
                        422,
                        "coordinate_range",
                        "Expected EPSG:4326 lon/lat",
                        field_errors=[
                            {
                                "path": "/geometry/coordinates",
                                "code": "coordinate_range",
                                "message": "Ожидаются конечные координаты долготы и широты EPSG:4326",
                            }
                        ],
                    )
    geometry = shape(value)
    if geometry.is_empty or not geometry.is_valid:
        raise DomainError(
            422,
            "invalid_geometry",
            "Geometry must be non-empty and topologically valid",
            field_errors=[
                {
                    "path": "/geometry",
                    "code": "invalid_geometry",
                    "message": "Геометрия пуста или имеет самопересечения",
                }
            ],
        )
    return geometry


def zone_area(value, boundary):
    geometry, city = area_geometry(value), area_geometry(boundary)
    if not city.covers(geometry):
        raise DomainError(
            422,
            "outside_city",
            "Zone must be covered by the selected city boundary",
            field_errors=[
                {
                    "path": "/geometry",
                    "code": "outside_city",
                    "message": "Контур выходит за рабочую границу выбранного города",
                }
            ],
        )
    area = transform(PROJECT, geometry).area
    if not math.isfinite(area) or area <= 0:
        raise DomainError(
            422,
            "invalid_area",
            "Projected area must be positive",
            field_errors=[
                {
                    "path": "/geometry",
                    "code": "invalid_area",
                    "message": "Расчётная площадь должна быть положительной",
                }
            ],
        )
    return area
