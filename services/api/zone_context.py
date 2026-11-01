"""Server-owned spatial context derived only from authorized current publications."""

from sqlalchemy import select, text

from packages.domain.errors import DomainError
from services.api.models import Dataset, DatasetVersion, ImportQuality

METHOD_VERSION = "zone-context-postgis-1"
MAX_RESTRICTIONS = 50
MAX_CONTEXT_GEOMETRY_POINTS = 1_000


def data_gap(code, message, *inputs, blocking=True):
    return {
        "code": code,
        "message": message,
        "required_inputs": list(inputs),
        "blocking": blocking,
    }


def source_ref(dataset):
    return {
        "dataset_version_id": dataset.current_version_id,
        "source_record_id": None,
        "label": dataset.payload["name"],
        "uri": dataset.payload["source_uri"],
    }


def metric(key, value, unit, status, sources, *, confidence="medium"):
    return {
        "key": key,
        "value": value,
        "unit": unit,
        "horizon_year": None,
        "status": status,
        "lower": None,
        "upper": None,
        "qualitative_confidence": confidence,
        "method_version": METHOD_VERSION,
        "source_refs": sources,
        "missing_reason": None,
    }


def unavailable_metric(key, unit, missing):
    return {
        "key": key,
        "value": None,
        "unit": unit,
        "horizon_year": None,
        "status": "unavailable",
        "lower": None,
        "upper": None,
        "qualitative_confidence": "unknown",
        "method_version": METHOD_VERSION,
        "source_refs": [],
        "missing_reason": missing,
    }


def accessible_current_datasets(db, access, city_id):
    values = []
    for dataset in db.scalars(
        select(Dataset)
        .where(Dataset.city_id == city_id, Dataset.current_version_id.is_not(None))
        .order_by(Dataset.id)
    ):
        try:
            access.dataset(dataset)
        except DomainError as error:
            if error.status in {403, 404}:
                continue
            raise
        values.append(dataset)
    return values


POLYGON_COVERAGE = text(
    """
    WITH zone AS (
      SELECT geometry,ST_Area(ST_Transform(geometry,32643)) AS area_m2
      FROM zone_versions WHERE id=:zone_version_id
    ), clipped AS (
      SELECT ST_Intersection(ir.geometry,zone.geometry) AS geom
      FROM import_records ir CROSS JOIN zone
      WHERE ir.version_id=ANY(CAST(:versions AS uuid[]))
        AND GeometryType(ir.geometry) IN ('POLYGON','MULTIPOLYGON')
        AND ir.geometry && zone.geometry
        AND ST_Intersects(ir.geometry,zone.geometry)
    )
    SELECT
      COALESCE(ST_Area(ST_Transform(ST_UnaryUnion(ST_Collect(geom)),32643)),0) AS area_m2,
      (SELECT area_m2 FROM zone) AS zone_area_m2
    FROM clipped WHERE NOT ST_IsEmpty(geom)
    """
)

GREEN_SUMMARY = text(
    """
    WITH zone AS (
      SELECT geometry FROM zone_versions WHERE id=:zone_version_id
    ), hits AS (
      SELECT ir.geometry
      FROM import_records ir CROSS JOIN zone
      WHERE ir.version_id=ANY(CAST(:versions AS uuid[]))
        AND ir.geometry && zone.geometry
        AND ST_Intersects(ir.geometry,zone.geometry)
    ), clipped_polygons AS (
      SELECT ST_Intersection(hits.geometry,zone.geometry) AS geom
      FROM hits CROSS JOIN zone
      WHERE GeometryType(hits.geometry) IN ('POLYGON','MULTIPOLYGON')
    )
    SELECT
      (SELECT count(*) FROM hits) AS feature_count,
      COALESCE(
        (SELECT ST_Area(ST_Transform(ST_UnaryUnion(ST_Collect(geom)),32643))
         FROM clipped_polygons WHERE NOT ST_IsEmpty(geom)),
        0
      ) AS area_m2
    """
)

RESTRICTION_STATS = text(
    """
    WITH zone AS (SELECT geometry FROM zone_versions WHERE id=:zone_version_id), hits AS (
      SELECT ir.payload->'properties' AS properties,ir.geometry
      FROM import_records ir CROSS JOIN zone
      WHERE ir.version_id=ANY(CAST(:versions AS uuid[]))
        AND ir.geometry && zone.geometry
        AND ST_Intersects(ir.geometry,zone.geometry)
    )
    SELECT
      count(*) AS hit_count,
      count(*) FILTER (WHERE COALESCE(properties->>'rule_version_id','') !~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$')
        AS missing_rule_count,
      count(*) FILTER (WHERE ST_NPoints(geometry)>:max_points) AS complex_count,
      count(*) FILTER (WHERE NULLIF(trim(properties->>'network_kind'),'') IS NOT NULL)
        AS network_count
    FROM hits
    """
)

RESTRICTIONS_QUERY = text(
    """
    WITH zone AS (SELECT geometry FROM zone_versions WHERE id=:zone_version_id)
    SELECT
      (md5('pavlodar:map-feature:' || ir.version_id::text || ':' || ir.row_index::text)::uuid)::text AS id,
      left(COALESCE(
        NULLIF(trim(ir.payload->'properties'->>'restriction_kind'),''),
        NULLIF(trim(ir.payload->'properties'->>'kind'),''),
        NULLIF(trim(ir.payload->'properties'->>'network_kind'),''),
        'restriction'
      ),200) AS kind,
      ir.payload->'properties'->>'rule_version_id' AS rule_version_id,
      ST_AsGeoJSON(ir.geometry,7)::jsonb AS geometry,
      CASE WHEN ir.payload->'properties'->>'status'='confirmed'
        THEN 'confirmed' ELSE 'unverified' END AS status
    FROM import_records ir CROSS JOIN zone
    WHERE ir.version_id=ANY(CAST(:versions AS uuid[]))
      AND ir.geometry && zone.geometry
      AND ST_Intersects(ir.geometry,zone.geometry)
      AND ST_NPoints(ir.geometry)<=:max_points
      AND COALESCE(ir.payload->'properties'->>'rule_version_id','') ~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    ORDER BY ir.version_id,ir.row_index
    LIMIT :fetch
    """
)


def _computed_status(db, datasets):
    versions = [db.get(DatasetVersion, dataset.current_version_id) for dataset in datasets]
    explicitly_labelled = any(
        "SYNTHETIC" in dataset.payload["name"].upper() for dataset in datasets
    )
    return (
        "synthetic"
        if explicitly_labelled or any(version.synthetic for version in versions)
        else "estimated"
    )


def build_zone_context(db, access, zone, version):
    datasets = accessible_current_datasets(db, access, zone.city_id)
    by_kind = {}
    for dataset in datasets:
        by_kind.setdefault(dataset.payload["kind"], []).append(dataset)

    gaps = []
    metrics = [
        metric(
            "zone_area",
            version.payload["area_m2"],
            "m2",
            "synthetic" if version.synthetic else "measured",
            [],
            confidence="high",
        )
    ]

    soil = by_kind.get("soil", [])
    if soil:
        row = db.execute(
            POLYGON_COVERAGE,
            {
                "zone_version_id": version.id,
                "versions": [item.current_version_id for item in soil],
            },
        ).mappings().one()
        coverage = min(1.0, float(row["area_m2"]) / float(row["zone_area_m2"]))
        refs = [source_ref(item) for item in soil]
        metrics.append(
            metric(
                "soil_coverage_fraction",
                coverage,
                "1",
                _computed_status(db, soil),
                refs,
            )
        )
        if coverage < 0.999:
            gaps.append(
                data_gap(
                    "soil_partial_coverage",
                    f"Почвенные источники покрывают {coverage:.1%} площади зоны",
                    *[item.current_version_id for item in soil],
                )
            )
    else:
        missing = data_gap(
            "soil_data_missing", "Нет принятого почвенного слоя для этой зоны", "DR-03"
        )
        gaps.append(missing)
        metrics.append(unavailable_metric("soil_coverage_fraction", "1", missing))

    green = by_kind.get("green_inventory", [])
    if green:
        row = db.execute(
            GREEN_SUMMARY,
            {
                "zone_version_id": version.id,
                "versions": [item.current_version_id for item in green],
            },
        ).mappings().one()
        refs = [source_ref(item) for item in green]
        status = _computed_status(db, green)
        metrics.extend(
            [
                metric("existing_green_area", float(row["area_m2"]), "m2", status, refs),
                metric(
                    "existing_green_feature_count",
                    float(row["feature_count"]),
                    "piece",
                    status,
                    refs,
                ),
            ]
        )
    else:
        missing = data_gap(
            "green_inventory_missing",
            "Нет принятого инвентаризационного слоя существующей зелени",
            "DR-01",
            blocking=False,
        )
        gaps.append(missing)
        metrics.extend(
            [
                unavailable_metric("existing_green_area", "m2", missing),
                unavailable_metric("existing_green_feature_count", "piece", missing),
            ]
        )

    restriction_sets = by_kind.get("restrictions", [])
    restrictions = []
    if restriction_sets:
        version_ids = [item.current_version_id for item in restriction_sets]
        stats = db.execute(
            RESTRICTION_STATS,
            {
                "zone_version_id": version.id,
                "versions": version_ids,
                "max_points": MAX_CONTEXT_GEOMETRY_POINTS,
            },
        ).mappings().one()
        restrictions = [
            dict(row)
            for row in db.execute(
                RESTRICTIONS_QUERY,
                {
                    "zone_version_id": version.id,
                    "versions": version_ids,
                    "max_points": MAX_CONTEXT_GEOMETRY_POINTS,
                    "fetch": MAX_RESTRICTIONS + 1,
                },
            ).mappings()
        ]
        if int(stats["hit_count"]) == 0:
            gaps.append(
                data_gap(
                    "restriction_clearance_unverified",
                    "Пустое пересечение слоя ограничений не подтверждает разрешение на посадку",
                    "DR-03",
                )
            )
        if int(stats["missing_rule_count"]):
            gaps.append(
                data_gap(
                    "restriction_rule_missing",
                    "Часть ограничений не имеет проверенной версии правила",
                    "DR-03",
                )
            )
        if int(stats["complex_count"]):
            gaps.append(
                data_gap(
                    "restriction_geometry_too_complex",
                    "Часть геометрий слишком подробна для карточки; используйте слой карты",
                    *version_ids,
                    blocking=False,
                )
            )
        if len(restrictions) > MAX_RESTRICTIONS:
            restrictions = restrictions[:MAX_RESTRICTIONS]
            gaps.append(
                data_gap(
                    "restriction_results_truncated",
                    f"Показаны первые {MAX_RESTRICTIONS} ограничений",
                    *version_ids,
                    blocking=False,
                )
            )
        if int(stats["network_count"]) == 0:
            gaps.append(
                data_gap(
                    "utility_network_data_missing",
                    "Нет разрешённого слоя инженерных сетей; пустота не означает безопасность",
                    "DR-03",
                )
            )
    else:
        gaps.extend(
            [
                data_gap(
                    "restriction_data_missing",
                    "Нет принятого слоя ограничений для этой зоны",
                    "DR-03",
                ),
                data_gap(
                    "utility_network_data_missing",
                    "Нет разрешённого слоя инженерных сетей; пустота не означает безопасность",
                    "DR-03",
                ),
            ]
        )

    for dataset in datasets:
        quality = db.get(ImportQuality, dataset.current_version_id)
        if quality and quality.payload["warning_count"]:
            gaps.append(
                data_gap(
                    "source_quality_warning",
                    f"Источник «{dataset.payload['name']}» опубликован с предупреждениями качества",
                    dataset.current_version_id,
                    blocking=False,
                )
            )

    refs = [
        source_ref(item)
        for item in datasets
        if item.payload["kind"] in {"soil", "green_inventory", "restrictions"}
    ]
    return {
        "zone_id": zone.id,
        "zone_version_id": version.id,
        "metrics": metrics,
        "source_refs": refs,
        "restrictions": restrictions,
        "data_gaps": gaps,
    }
