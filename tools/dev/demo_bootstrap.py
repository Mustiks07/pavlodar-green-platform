"""Idempotent demo contour of Pavlodar from the research package, through the canonical HTTP API.

Everything goes through the public API with ordinary sessions (no database writes). Re-running it
reuses what exists, matched by name or Latin name, so nothing is duplicated.

Created, only from research/data and only as far as the sources go:
- public evidence datasets: DR-02 plant candidates, DR-02 plant traits, DR-05 water tariffs and
  nursery prices (CSV files as delivered), BIOSAD nursery offers (stock, GeoJSON);
- 9 DR-02 catalog entries with Russian and Latin names and their traits as stated by the sources
  (ranges kept as text in the source units, nothing converted, unknown stays unknown), all with
  expert_status=pending; castor bean excluded for research risk;
- BIOSAD spruce offers in Pavlodar: no stock count exists, so the quantity stays unknown (the
  vendor's figure is kept as text) with availability vendor_reported, or unknown where the
  vendor says sold out (not_in_stock means a counted zero), never in_stock; the external GreenMax listing is not imported;
- the three published water tariffs as rate versions (tax excluded, later_changes_not_resolved);
- three planning zones, three planted scenario variants each, a server fast calculation for every
  variant and a city program draft built from an immutable server priority result.
- one explicitly labelled internal "Оценочный профиль MVP" with a synthetic expert-rule curve,
  source-backed planning rates, normalized suitability estimates, ecosystem profile and a monthly
  care calendar. Cost, survival and care are attached to all nine prepared projects so comparison
  and program planning have complete inputs. The ecosystem profile remains exclusive to the
  water-saving courtyard hero. Explicit synthetic stock and spatial priority layers let the real
  optimizer persist a roadmap. The server marks every prepared draft synthetic and blocks approval.

Not created, because the API correctly refuses it without real inputs (see the report): approval
and work orders (the MVP estimate is neither official nor locally calibrated).

Every source in DR-02/DR-05 lists its license as unknown, and the platform publishes a dataset
only with a known license. --license therefore has no default: it records the license decision
the data owner made for these compiled fact tables.

    uv run python -m tools.dev.demo_bootstrap --license "<decided license>"
    uv run python -m tools.dev.demo_bootstrap --check
"""

import argparse
import csv
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from uuid import NAMESPACE_URL, uuid4, uuid5

import httpx
from shapely.affinity import scale
from shapely.geometry import Point, mapping, shape

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "research/data"
OWNER = "Команда vtiposhnik · исследовательский пакет 29.10.2026"
DATASETS = {
    "plants": ("Каталог-кандидаты растений Павлодара (DR-02)", "catalog", "DR-02/plants.csv"),
    "traits": ("Признаки растений из справочников (DR-02)", "catalog", "DR-02/traits.csv"),
    "rates": ("Тарифы на воду и цены питомника (DR-05)", "rates", "DR-05/rates.csv"),
    "stock": ("Предложения питомника БИОСАД, Павлодар (DR-02)", "stock", None),
    "demo_rules": (
        "Оценочный профиль MVP · проектные правила",
        "restrictions",
        "demo-profile/rules.geojson",
    ),
    "demo_models": (
        "Оценочный профиль MVP · приживаемость 1/2/3 года",
        "models",
        "demo-profile/survival.geojson",
    ),
    "demo_ecosystem": (
        "Оценочный профиль MVP · экосистемные коэффициенты",
        "models",
        "demo-profile/ecosystem.geojson",
    ),
    "demo_population": (
        "SYNTHETIC TEST · Оценочный профиль MVP · расчётное население зон",
        "population",
        "demo-profile/population.csv",
    ),
    "demo_rates": (
        "Оценочный профиль MVP · плановые ставки",
        "rates",
        "demo-profile/rates.csv",
    ),
    "demo_suitability": (
        "Оценочный профиль MVP · пригодность растений 0–100",
        "catalog",
        "demo-profile/suitability.csv",
    ),
    "demo_stock": (
        "SYNTHETIC TEST · Оценочный профиль MVP · складские остатки",
        "stock",
        None,
    ),
    "demo_priority_green": (
        "SYNTHETIC TEST · Оценочный профиль MVP · существующая зелень",
        "green_inventory",
        None,
    ),
    "demo_priority_soil": (
        "SYNTHETIC TEST · Оценочный профиль MVP · почвенное покрытие",
        "soil",
        None,
    ),
}
MVP_METHOD = "SYNTHETIC TEST: Оценочный профиль MVP; только расчёт черновика"
MVP_RULE_ID = "8e7b6d54-76c6-5f66-8d21-a5f6cc58bca9"
MVP_COVERAGE_RULE_ID = "f6714b9a-11f4-5dfc-8205-46125498f0d6"
HERO_ZONE = "Двор жилого квартала"
HERO_SCENARIO = "Вариант B · экономия воды"
ECOSYSTEM_REQUIRED_KEYS = {
    "green_area",
    "green_area_per_person",
    "co2_sequestered",
    "pollutants_removed",
    "oxygen_produced",
    "air_cooling",
    "stormwater_retained",
}
ECOSYSTEM_COEFFICIENT_KEYS = ECOSYSTEM_REQUIRED_KEYS - {"green_area_per_person"}
SUITABILITY_KEYS = (
    "hardiness_fit",
    "moisture_fit",
    "salt_fit",
    "wind_fit",
    "light_fit",
)
STRATUM = {
    "populus_alba": "tree",
    "pinus_sylvestris": "tree",
    "tilia_cordata": "tree",
    "syringa_vulgaris": "shrub",
    "picea_obovata": "tree",
    "ricinus_communis": "shrub",
    "salix_sp": "tree",
    "acer_sp": "tree",
    "fraxinus_sp": "tree",
}


# Planning boundaries drawn for the demo in central Pavlodar: the Dostyk boulevard square, an inner
# courtyard east of it and a planting strip along the north kerb of Bekmakhanov street. They are
# proposals, not surveyed parcels. Each ring is (lon, lat) in WGS84.
def rect(center, half):
    x, y = center
    return [
        [x - half[0], y - half[1]],
        [x + half[0], y - half[1]],
        [x + half[0], y + half[1]],
        [x - half[0], y + half[1]],
    ]


ZONES = [
    (
        "Сквер у набережной",
        "square",
        rect((76.9527, 52.2889), (0.0004, 0.0017)),
    ),
    (
        "Двор жилого квартала",
        "courtyard",
        rect((76.95757, 52.28802), (0.0005, 0.00035)),
    ),
    (
        "Зелёный коридор вдоль улицы",
        "street",
        [[76.95541, 52.28326], [76.95898, 52.28339], [76.95898, 52.28345], [76.95541, 52.28333]],
    ),
]
LEGACY_ZONE_NAMES = {
    "Сквер у набережной": "Демо-участок 1 · сквер (условная граница)",
    "Двор жилого квартала": "Демо-участок 2 · двор (условная граница)",
    "Зелёный коридор вдоль улицы": "Демо-участок 3 · улица (условная граница)",
}
APPEND_KEYS = [
    "zone_version_id",
    "dataset_version_ids",
    "catalog_version_id",
    "rate_version_id",
    "rate_version_ids",
    "coefficient_version_id",
    "rule_version_id",
    "model_version_id",
    "placements",
    "area_patches",
    "capital_budget",
    "care_horizon_years",
    "resource_limits",
    "excluded_plant_ids",
    "diversity_caps",
    "care_strategy",
    "custom_care_operations",
]
VARIANTS = [
    ("Вариант A · стандартный уход", "standard", "standard"),
    ("Вариант B · экономия воды", "water_saving", "water_saving"),
    ("Вариант C · теневой акцент", "standard", "shade"),
]


def scenario_placements(geometry, plant_ids, layout, zone_name):
    """Deterministic, visibly separated draft placements inside the planning boundary."""
    polygon = shape(geometry)
    min_x, min_y, max_x, max_y = polygon.bounds
    points = []
    for y_part in (0.25, 0.5, 0.75):
        for x_part in (0.2, 0.4, 0.6, 0.8):
            point = Point(min_x + (max_x - min_x) * x_part, min_y + (max_y - min_y) * y_part)
            if polygon.covers(point):
                points.append([point.x, point.y])
    if len(points) < 5:
        center = polygon.representative_point()
        points.extend([[center.x, center.y]] * (5 - len(points)))
    taxa = {
        "standard": ["tilia_cordata", "picea_obovata", "syringa_vulgaris", "tilia_cordata", "syringa_vulgaris"],
        "water_saving": ["pinus_sylvestris", "picea_obovata", "syringa_vulgaris", "pinus_sylvestris", "syringa_vulgaris"],
        "shade": ["populus_alba", "tilia_cordata", "salix_sp", "fraxinus_sp", "syringa_vulgaris"],
    }[layout]
    return [
        {
            "id": str(uuid5(NAMESPACE_URL, f"pavlodar-demo:{zone_name}:{layout}:{index}")),
            "plant_id": plant_ids[taxon],
            "stock_item_id": None,
            "position": {"type": "Point", "coordinates": coordinates},
            "quantity": 3 if taxon == "syringa_vulgaris" else 1,
            "planting_date": "2027-05-15",
            "locked": False,
            "initial_height_m": None,
            "initial_crown_radius_m": None,
            "dimension_basis": "catalog",
        }
        for index, (taxon, coordinates) in enumerate(zip(taxa, points[: len(taxa)], strict=True), 1)
    ]


def rows(relative):
    with (DATA / relative).open(encoding="utf-8", newline="") as stream:
        return list(csv.DictReader(stream))


def value(raw):
    return None if raw in ("", "null", None) else raw


def ecosystem_profile():
    return json.loads((DATA / DATASETS["demo_ecosystem"][2]).read_text(encoding="utf-8"))


def has_demo_ecosystem(snapshot):
    metrics = {
        (item["key"], item["horizon_year"]): item
        for item in snapshot.get("ecosystem", [])
    }
    return all(
        metrics.get((key, horizon), {}).get("value") is not None
        and metrics[(key, horizon)]["status"] == "synthetic"
        for key in ECOSYSTEM_REQUIRED_KEYS
        for horizon in (5, 10, 20)
    )


def has_complete_mvp_planning(snapshot):
    return (
        snapshot.get("status") == "complete"
        and snapshot.get("cost", {}).get("status") == "complete"
        and snapshot["cost"].get("total") is not None
        and len(snapshot.get("care", [])) == 12
        and bool(snapshot.get("survival"))
        and all(
            point["probability"] is not None
            for result in snapshot["survival"]
            for point in result["points"]
        )
    )


class Api:
    def __init__(self, http):
        self.http = http

    def get(self, path, **params):
        response = self.http.get(path, params={k: v for k, v in params.items() if v is not None})
        if response.status_code >= 400:
            raise SystemExit(f"GET {path}: {response.status_code} {response.text[:300]}")
        return response.json()

    def etag(self, path):
        response = self.http.get(path)
        if response.status_code >= 400:
            raise SystemExit(f"GET {path}: {response.status_code} {response.text[:300]}")
        return response.json(), response.headers["ETag"]

    def send(
        self,
        method,
        path,
        body=None,
        expect=(200, 201, 202, 204),
        etag=None,
        idempotency_key=None,
    ):
        headers = {"Idempotency-Key": idempotency_key or str(uuid4())}
        if etag:
            headers["If-Match"] = etag
        response = self.http.request(method, path, json=body, headers=headers)
        if response.status_code not in expect:
            raise SystemExit(f"{method} {path}: {response.status_code} {response.text[:400]}")
        return response.json() if response.content else None

    def pages(self, path, **params):
        items, cursor = [], None
        while True:
            page = self.get(path, limit=200, cursor=cursor, **params)
            items.extend(page["items"])
            cursor = page.get("next_cursor")
            if not cursor:
                return items


def sign_in(base_url):
    """Disposable stacks hand out cookies (PG_SESSIONS); otherwise the real Keycloak flow."""
    clients = {}
    if os.environ.get("PG_SESSIONS"):
        sessions = json.loads(Path(os.environ["PG_SESSIONS"]).read_text(encoding="utf-8"))
        for role in ("specialist", "admin"):
            http = httpx.Client(base_url=os.environ.get("PG_API_ORIGIN", base_url), timeout=180)
            http.cookies.set("pavlodar_session", sessions[role]["cookie"])
            csrf = http.get("/v1/me").json()["csrf_token"]
            http.headers.update({"Origin": os.environ["PG_WEB_URL"], "X-CSRF-Token": csrf})
            clients[role] = Api(http)
        return clients
    from tools.dev.smoke_oidc import login

    for role in ("specialist", "admin"):
        http = httpx.Client(base_url=base_url, timeout=180, follow_redirects=False)
        login(http, role)
        clients[role] = Api(http)
    return clients


def wait_job(api, job_id):
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        job = api.get(f"/v1/jobs/{job_id}")
        if job["state"] in {"succeeded", "failed", "cancelled"}:
            if job["state"] != "succeeded":
                raise SystemExit(f"Job {job_id} ended {job['state']}: {job.get('error')}")
            return job
        time.sleep(1)
    raise SystemExit(f"Job {job_id} did not finish")


def ensure_dataset(
    sp,
    admin,
    city_id,
    key,
    content,
    content_type,
    filename,
    fmt,
    license_name,
    *,
    access_level="public",
    method=None,
):
    name, kind, _ = DATASETS[key]
    existing = next(
        (d for d in sp.pages("/v1/datasets", city_id=city_id) if d["name"] == name), None
    )
    if existing and existing.get("current_version_id"):
        return existing, existing["current_version_id"], False
    if license_name is None:
        raise SystemExit(f"{name}: not published yet; pass --license with the decided license")
    dataset = existing or sp.send(
        "POST",
        "/v1/datasets",
        {
            "city_id": city_id,
            "name": name,
            "kind": kind,
            "owner": OWNER,
            "license": license_name,
            "access_level": access_level,
            "source_uri": None,
        },
    )
    ticket = sp.send(
        "POST",
        f"/v1/datasets/{dataset['id']}/uploads",
        {
            "filename": filename,
            "content_type": content_type,
            "byte_size": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
        },
    )
    stored = sp.http.put(
        ticket["put_url"],
        content=content,
        headers={"Content-Type": content_type, "Idempotency-Key": str(uuid4())},
    )
    if stored.status_code != 204:
        raise SystemExit(f"upload {filename}: {stored.status_code} {stored.text[:200]}")
    job = sp.send(
        "POST",
        f"/v1/datasets/{dataset['id']}/imports",
        {
            "upload_id": ticket["upload_id"],
            "format": fmt,
            "source_crs": "EPSG:4326",
            "field_mapping": [],
            "observed_at": None,
            "method": method
            or "Исследовательский пакет команды, проверено 29.10.2026; источники в sources.csv",
            "spatial_resolution_m": None,
        },
    )
    version_id = wait_job(sp, job["id"])["result_ref_id"]
    admin.send(
        "POST",
        f"/v1/dataset-versions/{version_id}/publish",
        {"reason": "Демо-контур: факты исследовательского пакета со ссылками на источники"},
    )
    return dataset, version_id, True


def mvp_care_operations(scenario_id, revision, rate_ids):
    """Build a small, explicit estimate: three watering and one care visit per season."""
    placement_ids = [item["id"] for item in revision["placements"]]
    total_pieces = sum(item["quantity"] for item in revision["placements"])
    operations = []
    for year in range(3):
        for month in (5, 7, 9):
            operations.append(
                {
                    "id": str(
                        uuid5(
                            NAMESPACE_URL,
                            f"pavlodar-mvp-care:{scenario_id}:{year}:{month}:watering",
                        )
                    ),
                    "placement_ids": placement_ids,
                    "month": month,
                    "year_offset": year,
                    "operation": "Оценочный полив проектных посадок",
                    "quantity": 1.5,
                    "unit": "m3",
                    "water_m3": 1.5,
                    "crew_minutes": 90,
                    "visits": 1,
                    "rate_version_id": rate_ids["water"],
                    "rule_version_id": MVP_RULE_ID,
                }
            )
        operations.append(
            {
                "id": str(
                    uuid5(
                        NAMESPACE_URL,
                        f"pavlodar-mvp-care:{scenario_id}:{year}:5:care",
                    )
                ),
                "placement_ids": placement_ids,
                "month": 5,
                "year_offset": year,
                "operation": "Оценочный сезонный уход",
                "quantity": total_pieces,
                "unit": "piece",
                "water_m3": 0,
                "crew_minutes": 120,
                "visits": 1,
                "rate_version_id": rate_ids["care"],
                "rule_version_id": MVP_RULE_ID,
            }
        )
    return operations


def source(version_id, index):
    return {
        "dataset_version_id": version_id,
        "source_record_id": str(index),
        "label": "-",
        "uri": None,
    }


def plant_body(plant, traits_version, trait_rows):
    traits = []
    for index, row in trait_rows:
        text, low, high = value(row["value"]), value(row["lower"]), value(row["upper"])
        if text is None and (low or high):
            text = f"{low or '?'}–{high or '?'} {value(row['unit']) or ''}".strip()
        traits.append(
            {
                "key": row["trait"],
                "value_text": text,
                "value_number": None,
                "unit": None,
                "status": "known" if text else "unknown",
                "source_refs": [source(traits_version, index)],
            }
        )
    excluded = plant["school_hospital_status"] == "excluded_research_risk"
    toxicity = next((row for _, row in trait_rows if row["trait"] == "toxicity"), None)
    return {
        "latin_name": plant["scientific_name"],
        "russian_name": plant["name_ru"],
        "cultivar": value(plant["cultivar"]),
        "stratum": STRATUM[plant["taxon_id"]],
        "traits": traits,
        "allergy_risk": "unknown",
        "toxicity_risk": "present"
        if excluded and toxicity and value(toxicity["value"])
        else "unknown",
        "expert_status": "pending",
        "taxon_rank": plant["rank"],
        "local_evidence": value(plant["local_evidence"]),
        "sensitive_site_status": "excluded" if excluded else "requires_review",
        "exclusion_reason": plant["local_evidence"] if excluded else None,
        "exclusion_basis": "research_risk" if excluded else None,
        "review_reasons": [],
    }


def suitability_traits(row, version_id, source_record_id):
    return [
        {
            "key": key,
            "value_text": None,
            "value_number": float(row[key]),
            "unit": "1",
            "status": "known",
            "source_refs": [source(version_id, source_record_id)],
        }
        for key in SUITABILITY_KEYS
    ]


def plant_input_from_current(plant, extra_traits):
    return {
        key: plant[key]
        for key in (
            "latin_name",
            "russian_name",
            "cultivar",
            "stratum",
            "allergy_risk",
            "toxicity_risk",
            "expert_status",
            "taxon_rank",
            "local_evidence",
            "sensitive_site_status",
            "exclusion_reason",
            "exclusion_basis",
            "review_reasons",
        )
    } | {
        "traits": [
            trait for trait in plant["traits"] if trait["key"] not in SUITABILITY_KEYS
        ]
        + extra_traits
    }


def stock_geojson(city, picea_id):
    point = shape(city["boundary"]).representative_point()
    features = []
    for row in rows("DR-02/stock.csv"):
        if row["supplier_city"] != "Павлодар":
            continue  # GreenMax: external comparison, not Pavlodar availability
        # A quantity is a fact only with a stock count date; the vendor's figure stays text.
        counted = value(row["stock_count_date"])
        quantity = value(row["quantity"])
        availability = row["availability"]
        vendor_note = ""
        if quantity is not None and not counted:
            vendor_note = f" Продавец указал на карточке: {quantity} шт.; склад не пересчитан."
            # not_in_stock means a counted zero; without a count the state is unknown.
            if availability == "not_in_stock":
                availability = "unknown"
                vendor_note = " Продавец указал на карточке: нет в наличии; склад не пересчитан."
        features.append(
            {
                "type": "Feature",
                "id": row["stock_id"],
                "properties": {
                    "record_type": "stock_item",
                    "plant_id": picea_id,
                    "supplier": row["supplier"],
                    "size_description": f"Высота {row['height_m']} м",
                    "currency": row["currency"],
                    "observed_at": f"{row['checked_at']}T00:00:00Z",
                    "supplier_city": row["supplier_city"],
                    "is_local_supply": True,
                    "height_min_m": float(row["height_min_m"]),
                    "height_max_m": float(row["height_max_m"]),
                    "container": value(row["container"]),
                    "root_system": value(row["root_system"]),
                    "tax_mode": "unknown",
                    "applicability": row["applicability"]
                    + vendor_note
                    + " Точка — опорная точка города, не адрес питомника.",
                    "available_quantity": int(quantity)
                    if quantity is not None and counted
                    else None,
                    "unit_price": value(row["price"]),
                    "availability": availability,
                    "stock_counted_at": counted,
                    "checked_at": row["checked_at"],
                },
                "geometry": {"type": "Point", "coordinates": [point.x, point.y]},
            }
        )
    return json.dumps(
        {"type": "FeatureCollection", "features": features}, ensure_ascii=False
    ).encode()


def mvp_stock_geojson(city, plant_ids):
    point = shape(city["boundary"]).representative_point()
    features = []
    for row in rows("demo-profile/suitability.csv"):
        taxon_id = row["taxon_id"]
        features.append(
            {
                "type": "Feature",
                "id": f"mvp-stock-{taxon_id}",
                "properties": {
                    "record_type": "stock_item",
                    "plant_id": plant_ids[taxon_id],
                    "supplier": "SYNTHETIC TEST · Оценочный профиль MVP",
                    "size_description": "Условная единица проектного посадочного материала",
                    "currency": "KZT",
                    "observed_at": "2026-10-31T00:00:00Z",
                    "supplier_city": "Павлодар",
                    "is_local_supply": None,
                    "height_min_m": None,
                    "height_max_m": None,
                    "container": None,
                    "root_system": None,
                    "tax_mode": "included",
                    "applicability": (
                        "SYNTHETIC TEST: условный остаток только для проверки планировочного "
                        "оптимизатора; не является фактическим наличием поставщика"
                    ),
                    "available_quantity": 1000,
                    "unit_price": "18000.00",
                    "availability": "in_stock",
                    "stock_counted_at": "2026-10-31",
                    "checked_at": "2026-10-31",
                },
                "geometry": {"type": "Point", "coordinates": [point.x, point.y]},
            }
        )
    return json.dumps(
        {"type": "FeatureCollection", "features": features}, ensure_ascii=False
    ).encode()


def priority_profile_geojson(kind):
    green_fractions = {
        "Сквер у набережной": 0.55,
        "Двор жилого квартала": 0.20,
        "Зелёный коридор вдоль улицы": 0.35,
    }
    features = []
    for name, _, ring in ZONES:
        polygon = shape({"type": "Polygon", "coordinates": [ring + [ring[0]]]})
        geometry = (
            scale(
                polygon,
                xfact=green_fractions[name] ** 0.5,
                yfact=green_fractions[name] ** 0.5,
                origin="centroid",
            )
            if kind == "green"
            else polygon
        )
        features.append(
            {
                "type": "Feature",
                "id": f"mvp-priority-{kind}-{name}",
                "properties": {
                    "name": name,
                    "profile": "SYNTHETIC TEST · Оценочный профиль MVP",
                    "method": (
                        "qualitative planning coverage, not surveyed or locally calibrated"
                    ),
                },
                "geometry": mapping(geometry),
            }
        )
    return json.dumps(
        {"type": "FeatureCollection", "features": features}, ensure_ascii=False
    ).encode()


def population_profile_geojson(zones_by_name):
    """Bind explicit synthetic population inputs to the exact demo zone identifiers."""
    features = []
    for index, row in enumerate(rows("demo-profile/population.csv")):
        zone = zones_by_name[row["zone_name"]]
        point = shape(zone["geometry"]).representative_point()
        features.append(
            {
                "type": "Feature",
                "id": f"mvp-population-{index + 1}",
                "properties": {
                    "record_type": "population_input",
                    "zone_id": zone["id"],
                    "population_count": int(row["population_count"]),
                    "qualitative_confidence": row["qualitative_confidence"],
                    "source_label": "SYNTHETIC TEST · расчётное население проектной зоны",
                    "source_url": None,
                    "method_note": row["method_note"],
                },
                "geometry": mapping(point),
            }
        )
    return json.dumps(
        {"type": "FeatureCollection", "features": features}, ensure_ascii=False
    ).encode()


def zone_geometry(city, ring):
    boundary = shape(city["boundary"])
    polygon = {"type": "Polygon", "coordinates": [ring + [ring[0]]]}
    if not boundary.contains(shape(polygon)):
        raise SystemExit(f"Demo zone {ring[0]} is outside {city['name']}")
    return polygon


def bootstrap(clients, city, license_name):
    sp, admin = clients["specialist"], clients["admin"]
    report = {"city": city["name"], "created": {}, "reused": {}}

    def count(kind, created):
        bucket = report["created" if created else "reused"]
        bucket[kind] = bucket.get(kind, 0) + 1

    versions = {}
    for key in ("plants", "traits", "rates"):
        content = (DATA / DATASETS[key][2]).read_bytes()
        _, versions[key], created = ensure_dataset(
            sp,
            admin,
            city["id"],
            key,
            content,
            "text/csv",
            Path(DATASETS[key][2]).name,
            "csv",
            license_name,
        )
        count("datasets", created)

    trait_rows = {}
    for index, row in enumerate(rows("DR-02/traits.csv")):
        trait_rows.setdefault(row["taxon_id"], []).append((index, row))
    plant_ids = {}
    for plant in rows("DR-02/plants.csv"):
        found = next(
            (
                p
                for p in sp.pages("/v1/plants", q=plant["scientific_name"])
                if p["latin_name"] == plant["scientific_name"]
            ),
            None,
        )
        count("plants", found is None)
        if found is None:
            found = admin.send(
                "POST",
                "/v1/plants",
                plant_body(plant, versions["traits"], trait_rows[plant["taxon_id"]]),
            )
        plant_ids[plant["taxon_id"]] = found["id"]

    _, versions["stock"], created = ensure_dataset(
        sp,
        admin,
        city["id"],
        "stock",
        stock_geojson(city, plant_ids["picea_obovata"]),
        "application/geo+json",
        "biosad-stock.geojson",
        "geojson",
        license_name,
    )
    count("datasets", created)

    for key, content_type, fmt in (
        ("demo_rules", "application/geo+json", "geojson"),
        ("demo_models", "application/geo+json", "geojson"),
        ("demo_ecosystem", "application/geo+json", "geojson"),
        ("demo_rates", "text/csv", "csv"),
    ):
        relative = DATASETS[key][2]
        _, versions[key], created = ensure_dataset(
            sp,
            admin,
            city["id"],
            key,
            (DATA / relative).read_bytes(),
            content_type,
            Path(relative).name,
            fmt,
            license_name,
            access_level="internal",
            method=MVP_METHOD,
        )
        count("datasets", created)

    suitability_relative = DATASETS["demo_suitability"][2]
    _, versions["demo_suitability"], created = ensure_dataset(
        sp,
        admin,
        city["id"],
        "demo_suitability",
        (DATA / suitability_relative).read_bytes(),
        "text/csv",
        Path(suitability_relative).name,
        "csv",
        license_name,
        # The canonical global catalog accepts only public trait evidence. Provenance remains
        # synthetic through the exact import method marker and the explicit dataset name.
        access_level="public",
        method=MVP_METHOD,
    )
    count("datasets", created)

    # Population records carry the canonical zone UUID, so create/version the three zones before
    # importing that standalone dataset. The scenario pass below reuses these exact versions.
    current_zones = sp.pages("/v1/zones", city_id=city["id"])
    demo_zones = {}
    for name, purpose, ring in ZONES:
        zone = next(
            (
                item
                for item in current_zones
                if item["name"] in {name, LEGACY_ZONE_NAMES.get(name)}
            ),
            None,
        )
        geometry = zone_geometry(city, ring)
        body = {
            "city_id": city["id"],
            "name": name,
            "purpose": purpose,
            "geometry": geometry,
        }
        count("zones", zone is None)
        if zone is None:
            zone = sp.send("POST", "/v1/zones", body)
        elif zone["name"] != name or shape(zone["geometry"]).symmetric_difference(
            shape(geometry)
        ).area > 1e-12:
            _, tag = sp.etag(f"/v1/zones/{zone['id']}")
            zone = sp.send("PUT", f"/v1/zones/{zone['id']}", body, etag=tag)
            count("zones_moved", True)
        demo_zones[name] = zone

    generated_profile_datasets = {
        "demo_stock": mvp_stock_geojson(city, plant_ids),
        "demo_priority_green": priority_profile_geojson("green"),
        "demo_priority_soil": priority_profile_geojson("soil"),
        "demo_population": population_profile_geojson(demo_zones),
    }
    for key, content in generated_profile_datasets.items():
        _, versions[key], created = ensure_dataset(
            sp,
            admin,
            city["id"],
            key,
            content,
            "application/geo+json",
            f"{key}.geojson",
            "geojson",
            license_name,
            access_level="internal",
            method=MVP_METHOD,
        )
        count("datasets", created)

    existing_rates = admin.pages("/v1/rates", city_id=city["id"])
    rate_ids = []
    for index, row in enumerate(rows("DR-05/rates.csv")):
        if row["category"] != "water":
            continue  # nursery prices live on the stock offers; no generic plant price is invented
        match = next(
            (
                r
                for r in existing_rates
                if r["category"] == "water"
                and r["unit_price"] == row["amount"]
                and r["valid_from"] == row["valid_from"]
            ),
            None,
        )
        if match is None:
            match = admin.send(
                "POST",
                "/v1/rates",
                {
                    "city_id": city["id"],
                    "category": "water",
                    "unit": row["unit"],
                    "unit_price": row["amount"],
                    "currency": row["currency"],
                    "valid_from": row["valid_from"],
                    "valid_to": value(row["valid_to"]),
                    "tax_mode": row["tax_status"],
                    "source_refs": [source(versions["rates"], index)],
                    "price_observed_at": row["price_observed_at"],
                    "checked_at": "2026-10-29",
                    "applicability_status": "later_changes_not_resolved",
                    "included": value(row["included"]) or row["applicability"],
                    "excluded": value(row["excluded"]) or "Прочие категории затрат",
                },
            )
            count("rates", True)
        else:
            count("rates", False)
        rate_ids.append(match["version_id"])

    profile_rate_ids = {}
    existing_profile_rates = admin.pages("/v1/rates", city_id=city["id"])
    for index, row in enumerate(rows("demo-profile/rates.csv")):
        match = next(
            (
                rate
                for rate in existing_profile_rates
                if rate["category"] == row["category"]
                and rate["unit"] == row["unit"]
                and any(
                    ref["dataset_version_id"] == versions["demo_rates"]
                    for ref in rate["source_refs"]
                )
            ),
            None,
        )
        if match is None:
            match = admin.send(
                "POST",
                "/v1/rates",
                {
                    "city_id": city["id"],
                    "category": row["category"],
                    "unit": row["unit"],
                    "unit_price": row["amount"],
                    "currency": row["currency"],
                    "valid_from": row["valid_from"],
                    "valid_to": row["valid_to"],
                    "tax_mode": row["tax_mode"],
                    "source_refs": [source(versions["demo_rates"], index)],
                    "price_observed_at": row["price_observed_at"],
                    "checked_at": row["checked_at"],
                    "applicability_status": "current",
                    "included": row["included"],
                    "excluded": row["excluded"],
                },
            )
            count("mvp_rates", True)
        else:
            count("mvp_rates", False)
        profile_rate_ids[row["category"]] = match["version_id"]

    profile_models = [
        model
        for model in sp.pages("/v1/model-versions", city_id=city["id"], usable=True)
        if any(
            ref["dataset_version_id"] == versions["demo_models"]
            for ref in model["source_refs"]
        )
    ]
    if len(profile_models) != 1:
        raise SystemExit("Оценочный профиль MVP должен содержать одну доступную модель")
    profile_model_id = profile_models[0]["id"]

    ecosystem_refs = [
        source(versions["demo_ecosystem"], feature["id"])
        for feature in ecosystem_profile()["features"]
    ]
    profile_coefficients = [
        coefficient
        for coefficient in admin.pages("/v1/coefficients")
        if coefficient["key"] == "ecosystem_profile"
        and any(
            ref["dataset_version_id"] == versions["demo_ecosystem"]
            for ref in coefficient["source_refs"]
        )
    ]
    if len(profile_coefficients) > 1:
        raise SystemExit("Оценочный профиль MVP содержит дубли экосистемных коэффициентов")
    if profile_coefficients:
        profile_coefficient = profile_coefficients[0]
        count("mvp_coefficients", False)
    else:
        profile_coefficient = admin.send(
            "POST",
            "/v1/coefficients",
            {
                "key": "ecosystem_profile",
                "value": 1,
                "unit": "profile",
                "applicability": (
                    "SYNTHETIC TEST: внутренние планировочные гипотезы площади кроны и "
                    "нелокальные справочные ставки; только водосберегающий MVP-сценарий"
                ),
                "expert_status": "approved",
                "source_refs": ecosystem_refs,
            },
        )
        count("mvp_coefficients", True)
    profile_coefficient_id = profile_coefficient["version_id"]
    sp.get(f"/v1/rule-versions/{MVP_RULE_ID}")
    sp.get(f"/v1/rule-versions/{MVP_COVERAGE_RULE_ID}")

    current_plants = sp.pages("/v1/plants")
    catalog_ids = {
        plant["version_id"] for plant in current_plants if plant["id"] in set(plant_ids.values())
    }
    if len(catalog_ids) != 1:
        raise SystemExit("The demo plants are not in one current catalog version")
    catalog_id = catalog_ids.pop()

    suitability_rows = rows("demo-profile/suitability.csv")
    for index, row in enumerate(suitability_rows):
        plant_id = plant_ids[row["taxon_id"]]
        current, tag = admin.etag(f"/v1/plants/{plant_id}")
        existing = {trait["key"]: trait for trait in current["traits"]}
        already_current = all(
            key in existing
            and existing[key]["value_number"] == float(row[key])
            and existing[key]["unit"] == "1"
            and any(
                ref["dataset_version_id"] == versions["demo_suitability"]
                for ref in existing[key]["source_refs"]
            )
            for key in SUITABILITY_KEYS
        )
        if already_current:
            count("mvp_suitability_plants", False)
            continue
        updated = admin.send(
            "PUT",
            f"/v1/plants/{plant_id}",
            plant_input_from_current(
                current,
                suitability_traits(row, versions["demo_suitability"], index),
            ),
            etag=tag,
        )
        if not all(
            trait["source_refs"][0]["dataset_version_id"]
            == versions["demo_suitability"]
            for trait in updated["traits"]
            if trait["key"] in SUITABILITY_KEYS
        ):
            raise SystemExit("Оценочный профиль пригодности потерял synthetic provenance")
        count("mvp_suitability_plants", True)

    profile_plants = sp.pages("/v1/plants")
    profile_catalog_ids = {
        plant["version_id"] for plant in profile_plants if plant["id"] in set(plant_ids.values())
    }
    if len(profile_catalog_ids) != 1:
        raise SystemExit("Оценочный профиль пригодности не собран в один CatalogVersion")
    profile_catalog_id = profile_catalog_ids.pop()

    profile_stock_by_plant = {}
    for row in suitability_rows:
        plant_id = plant_ids[row["taxon_id"]]
        offers = [
            item
            for item in sp.pages("/v1/stock", plant_id=plant_id)
            if any(
                ref["dataset_version_id"] == versions["demo_stock"]
                for ref in item["source_refs"]
            )
        ]
        if len(offers) != 1 or offers[0]["available_quantity"] is None:
            raise SystemExit(
                f"Оценочный профиль MVP должен содержать один exact stock для {row['taxon_id']}"
            )
        profile_stock_by_plant[plant_id] = offers[0]["id"]

    program_zone_ids = []
    program_revision_ids = []
    for name, purpose, ring in ZONES:
        zone = demo_zones[name]
        geometry = zone_geometry(city, ring)
        program_zone_ids.append(zone["id"])
        scenarios = sp.pages("/v1/scenarios", city_id=city["id"], zone_id=zone["id"])
        for title, strategy, layout in VARIANTS:
            scenario = next((s for s in scenarios if s["name"] == title), None)
            if scenario is None:
                scenario = sp.send(
                    "POST",
                    "/v1/scenarios",
                    {
                        "city_id": city["id"],
                        "zone_id": zone["id"],
                        "name": title,
                        "base_revision_id": None,
                        "initial_state": {
                            "zone_version_id": zone["version_id"],
                            "parent_revision_id": None,
                            "dataset_version_ids": [],
                            "catalog_version_id": None,
                            "rate_version_id": None,
                            "coefficient_version_id": None,
                            "rule_version_id": None,
                            "model_version_id": None,
                            "placements": [],
                            "area_patches": [],
                            "capital_budget": None,
                            "care_horizon_years": 3,
                            "resource_limits": [],
                            "excluded_plant_ids": [],
                            "diversity_caps": [],
                            "care_strategy": strategy,
                            "custom_care_operations": [],
                            "comment": "Проектный вариант без посадок: посадки требуют правила, подтверждённого экспертом",
                        },
                    },
                )
                count("scenarios", True)
            else:
                count("scenarios", False)
            revision = sp.get(f"/v1/scenario-revisions/{scenario['current_revision_id']}")
            if revision["zone_version_id"] != zone["version_id"]:
                _, tag = sp.etag(f"/v1/scenarios/{scenario['id']}")
                rebased = {key: revision[key] for key in APPEND_KEYS}
                rebased.update(
                    zone_version_id=zone["version_id"],
                    parent_revision_id=revision["id"],
                    comment="Проектный вариант перенесён на уточнённую условную границу участка",
                )
                revision = sp.send(
                    "POST", f"/v1/scenarios/{scenario['id']}/revisions", rebased, etag=tag
                )
                count("scenarios_rebased", True)
            if not revision["placements"]:
                _, tag = sp.etag(f"/v1/scenarios/{scenario['id']}")
                planted = {key: revision[key] for key in APPEND_KEYS}
                planted.update(
                    parent_revision_id=revision["id"],
                    catalog_version_id=catalog_id,
                    placements=scenario_placements(geometry, plant_ids, layout, name),
                    comment=(
                        "Проектный вариант с посадками для обсуждения с ИИ-ассистентом: "
                        + {
                            "standard": "разнообразная композиция и стандартный уход",
                            "water_saving": "хвойные акценты и экономия воды",
                            "shade": "лиственные породы и более плотная тень",
                        }[layout]
                    ),
                )
                revision = sp.send(
                    "POST", f"/v1/scenarios/{scenario['id']}/revisions", planted, etag=tag
                )
                count("scenario_placements", True)
            is_hero = name == HERO_ZONE and title == HERO_SCENARIO
            planning_versions = {
                versions["demo_rules"],
                versions["demo_models"],
                versions["demo_rates"],
                versions["demo_suitability"],
                versions["demo_stock"],
            }
            required_versions = planning_versions | (
                {versions["demo_ecosystem"], versions["demo_population"]}
                if is_hero
                else set()
            )
            desired_coefficient_id = profile_coefficient_id if is_hero else None
            if (
                revision["catalog_version_id"] != profile_catalog_id
                or revision["rule_version_id"] != MVP_RULE_ID
                or revision["model_version_id"] != profile_model_id
                or revision["coefficient_version_id"] != desired_coefficient_id
                or set(revision["rate_version_ids"]) != set(profile_rate_ids.values())
                or revision["care_strategy"] != "custom"
                or len(revision["custom_care_operations"]) != 12
                or any(
                    placement["stock_item_id"]
                    != profile_stock_by_plant.get(placement["plant_id"])
                    for placement in revision["placements"]
                )
                or not (revision["comment"] or "").startswith(
                    "SYNTHETIC TEST · Оценочный профиль MVP"
                )
                or not required_versions.issubset(revision["dataset_version_ids"])
                or (
                    not is_hero
                    and (
                        versions["demo_ecosystem"] in revision["dataset_version_ids"]
                        or versions["demo_population"]
                        in revision["dataset_version_ids"]
                    )
                )
            ):
                _, tag = sp.etag(f"/v1/scenarios/{scenario['id']}")
                estimated = {key: revision[key] for key in APPEND_KEYS}
                estimated.update(
                    parent_revision_id=revision["id"],
                    dataset_version_ids=sorted(
                        (
                            set(revision["dataset_version_ids"])
                            - {
                                versions["demo_ecosystem"],
                                versions["demo_population"],
                            }
                        )
                        | required_versions
                    ),
                    catalog_version_id=profile_catalog_id,
                    placements=[
                        {
                            **placement,
                            "stock_item_id": profile_stock_by_plant[placement["plant_id"]],
                        }
                        for placement in revision["placements"]
                    ],
                    rate_version_id=None,
                    rate_version_ids=sorted(profile_rate_ids.values()),
                    rule_version_id=MVP_RULE_ID,
                    model_version_id=profile_model_id,
                    coefficient_version_id=desired_coefficient_id,
                    capital_budget="5000000.00",
                    resource_limits=[
                        {
                            "period": f"year:{year}",
                            "water_m3": 100.0,
                            "crew_minutes": 100000,
                            "max_visits": 1000,
                            "care_budget": "5000000.00",
                        }
                        for year in range(3)
                    ],
                    care_strategy="custom",
                    custom_care_operations=mvp_care_operations(
                        scenario["id"], revision, profile_rate_ids
                    ),
                    comment=(
                        f"SYNTHETIC TEST · Оценочный профиль MVP: {title.lower()} с расчётной сметой, "
                        "некалиброванной приживаемостью и календарём ухода. "
                        "Не является официальным или локально утверждённым расчётом."
                    ),
                )
                revision = sp.send(
                    "POST", f"/v1/scenarios/{scenario['id']}/revisions", estimated, etag=tag
                )
                if not revision["synthetic_inputs"]:
                    raise SystemExit("Оценочный профиль MVP потерял synthetic provenance")
                count("mvp_prepared_revisions", True)
            revision_id = revision["id"]
            program_revision_ids.append(revision_id)
            snapshots = sp.get(
                "/v1/calculations", scenario_revision_id=revision_id
            )["items"]
            needs_calculation = not any(
                has_complete_mvp_planning(snapshot)
                and (has_demo_ecosystem(snapshot) if is_hero else not snapshot["ecosystem"])
                for snapshot in snapshots
            )
            if needs_calculation:
                sp.send(
                    "POST",
                    "/v1/calculations/fast",
                    {
                        "scenario_revision_id": revision_id,
                        "mode": "fast",
                        # The canonical fast route is intentionally limited to interactive modules;
                        # ecosystem belongs to the durable full calculation below.
                        "include_modules": ["cost", "survival", "care"],
                        "seed": 0,
                    },
                )
                count("calculations", True)
            else:
                count("calculations", False)
            full_job = sp.send(
                "POST",
                "/v1/calculations",
                {
                    "scenario_revision_id": revision_id,
                    "mode": "full",
                    "include_modules": ["cost", "survival", "care"]
                    + (["ecosystem"] if is_hero else []),
                    "seed": 0,
                },
                idempotency_key=f"mvp-full:{revision_id}",
            )
            wait_job(sp, full_job["id"])
    program_name = "Программа озеленения Павлодара · 2027"
    programs = sp.pages("/v1/programs", city_id=city["id"])
    program = next((item for item in programs if item["name"] == program_name), None)
    normalization = sp.get("/v1/priority-normalizations")["items"][0]
    weights = [
        {"factor": factor["factor"], "weight": 1.0}
        for factor in normalization["factors"]
    ]
    priority = None
    if program is not None and program.get("priority_result_id"):
        frozen_priority = sp.get(f"/v1/priorities/{program['priority_result_id']}")
        frozen_priority_sources = {
            ref["dataset_version_id"]
            for zone_priority in frozen_priority["zones"]
            for contribution in zone_priority["contributions"]
            for ref in contribution["source_refs"]
        }
        if (
            frozen_priority["weights"] == weights
            and {item["zone_id"] for item in frozen_priority["zones"]}
            == set(program_zone_ids)
            and all(item["score"] is not None for item in frozen_priority["zones"])
            and {
                versions["demo_priority_green"],
                versions["demo_priority_soil"],
            }
            <= frozen_priority_sources
        ):
            priority = frozen_priority
    if priority is None:
        priority = sp.send(
            "POST",
            "/v1/priorities",
            {
                "city_id": city["id"],
                "zone_ids": program_zone_ids,
                "weights": weights,
                "normalization_version_id": normalization["id"],
            },
        )
        if any(item["score"] is None for item in priority["zones"]):
            raise SystemExit("Оценочный профиль MVP не заполнил входы приоритизации")
        count("mvp_priorities", True)
    else:
        count("mvp_priorities", False)
    program_resource_limits = [
        {
            "period": f"year:{year}",
            "water_m3": 12000.0,
            "crew_minutes": 240000,
            "max_visits": 720,
            "care_budget": "30000000.00",
        }
        for year in range(3)
    ]
    if program is None:
        program = sp.send(
            "POST",
            "/v1/programs",
            {
                "city_id": city["id"],
                "name": program_name,
                "capital_budget": "150000000.00",
                "resource_limits": program_resource_limits,
                "candidate_revision_ids": program_revision_ids,
                "required_zone_ids": [],
                "excluded_zone_ids": [],
                "benefit_weights": weights,
                "diversity_caps": [],
                "coverage_requirements": [],
                "priority_result_id": priority["id"],
            },
        )
        count("programs", True)
    else:
        count("programs", False)
        if (
            set(program["candidate_revision_ids"]) != set(program_revision_ids)
            or program.get("priority_result_id") != priority["id"]
            or program["benefit_weights"] != weights
            or program["resource_limits"] != program_resource_limits
        ):
            _, tag = sp.etag(f"/v1/programs/{program['id']}")
            body = {
                key: program[key]
                for key in (
                    "city_id",
                    "name",
                    "capital_budget",
                    "resource_limits",
                    "required_zone_ids",
                    "excluded_zone_ids",
                    "benefit_weights",
                    "diversity_caps",
                    "coverage_requirements",
                    "priority_result_id",
                )
            }
            body["candidate_revision_ids"] = program_revision_ids
            body["benefit_weights"] = weights
            body["priority_result_id"] = priority["id"]
            body["resource_limits"] = program_resource_limits
            program = sp.send("PUT", f"/v1/programs/{program['id']}", body, etag=tag)
            count("programs_updated", True)
    if program["status"] != "draft":
        raise SystemExit("Демо-программа должна оставаться черновиком для оптимизации")
    program, program_tag = sp.etag(f"/v1/programs/{program['id']}")
    optimize_job = sp.send(
        "POST",
        f"/v1/programs/{program['id']}/optimize",
        {
            "program_id": program["id"],
            "time_limit_seconds": 10,
            "seed": 0,
        },
        etag=program_tag,
        # ProgramInputVersion is internal and intentionally absent from the public contract;
        # updated_at changes whenever the immutable optimizer input is replaced.
        idempotency_key=f"mvp-optimize:{program['updated_at']}",
    )
    optimized = wait_job(sp, optimize_job["id"])
    roadmap = sp.get(f"/v1/program-revisions/{optimized['result_ref_id']}")
    if roadmap["solver_status"] not in {"optimal", "feasible"}:
        raise SystemExit(
            f"Демо-оптимизатор завершился со статусом {roadmap['solver_status']}"
        )
    if not roadmap["selected_scenario_revision_ids"]:
        raise SystemExit("Демо-оптимизатор не выбрал ни одного проекта")
    count("mvp_roadmaps", True)
    return report


def check(clients, city):
    """Read-only verification of the demo contour and of what the sources must not turn into."""
    sp = clients["specialist"]
    problems = []
    datasets = {d["name"]: d for d in sp.pages("/v1/datasets", city_id=city["id"])}
    published = [
        name for name, _, _ in DATASETS.values() if datasets.get(name, {}).get("current_version_id")
    ]
    ecosystem_version_id = datasets.get(DATASETS["demo_ecosystem"][0], {}).get(
        "current_version_id"
    )
    population_version_id = datasets.get(DATASETS["demo_population"][0], {}).get(
        "current_version_id"
    )
    suitability_version_id = datasets.get(DATASETS["demo_suitability"][0], {}).get(
        "current_version_id"
    )
    stock_version_id = datasets.get(DATASETS["demo_stock"][0], {}).get(
        "current_version_id"
    )
    priority_green_version_id = datasets.get(
        DATASETS["demo_priority_green"][0], {}
    ).get("current_version_id")
    priority_soil_version_id = datasets.get(DATASETS["demo_priority_soil"][0], {}).get(
        "current_version_id"
    )
    ecosystem_coefficients = [
        coefficient
        for coefficient in sp.pages("/v1/coefficients")
        if coefficient["key"] == "ecosystem_profile"
        and any(
            ref["dataset_version_id"] == ecosystem_version_id
            for ref in coefficient["source_refs"]
        )
    ]
    if len(ecosystem_coefficients) != 1:
        problems.append(
            f"MVP ecosystem coefficient profiles: {len(ecosystem_coefficients)} != 1"
        )
    profile_coefficient = ecosystem_coefficients[0] if len(ecosystem_coefficients) == 1 else None
    expected_ecosystem_sources = {
        feature["id"] for feature in ecosystem_profile()["features"]
    }
    if profile_coefficient is not None:
        if profile_coefficient["expert_status"] != "approved":
            problems.append("MVP ecosystem coefficient is not expert-approved")
        if {
            ref["source_record_id"] for ref in profile_coefficient["source_refs"]
        } != expected_ecosystem_sources:
            problems.append("MVP ecosystem coefficient does not freeze every profile record")
    plants = [
        p
        for p in sp.pages("/v1/plants")
        if p["latin_name"] in {r["scientific_name"] for r in rows("DR-02/plants.csv")}
    ]
    profile_catalog_ids = {plant["version_id"] for plant in plants}
    profile_catalog_id = (
        profile_catalog_ids.pop() if len(profile_catalog_ids) == 1 else None
    )
    if profile_catalog_id is None:
        problems.append("MVP suitability traits are not frozen in one catalog version")
    if any(p["expert_status"] == "approved" for p in plants):
        problems.append("a research candidate is marked expert-approved")
    for p in plants:
        for trait in p["traits"]:
            if trait["status"] == "unknown" and (
                trait["value_text"] or trait["value_number"] is not None
            ):
                problems.append(f"{p['latin_name']}: unknown trait has a value")
        suitability = {
            trait["key"]: trait for trait in p["traits"] if trait["key"] in SUITABILITY_KEYS
        }
        if p["latin_name"] == "Ricinus communis":
            if suitability:
                problems.append("excluded castor bean received MVP suitability scores")
        elif set(suitability) != set(SUITABILITY_KEYS) or any(
            trait["unit"] != "1"
            or trait["value_number"] is None
            or not 0 <= trait["value_number"] <= 1
            or not any(
                ref["dataset_version_id"] == suitability_version_id
                for ref in trait["source_refs"]
            )
            for trait in suitability.values()
        ):
            problems.append(f"{p['latin_name']}: MVP suitability profile is incomplete")
    stock = []
    for p in plants:
        stock.extend(sp.pages("/v1/stock", plant_id=p["id"]))
    for item in stock:
        if item["availability"] == "in_stock" and item["stock_counted_at"] is None:
            problems.append(f"stock {item['id']}: in_stock without a counted date")
        if item["available_quantity"] is not None and item["stock_counted_at"] is None:
            problems.append(f"stock {item['id']}: quantity without a stock count date")
    profile_stock_ids = {
        item["id"]
        for item in stock
        if any(
            ref["dataset_version_id"] == stock_version_id
            for ref in item["source_refs"]
        )
    }
    if len(profile_stock_ids) != 8:
        problems.append(f"MVP exact stock offers: {len(profile_stock_ids)} != 8")
    research_rate_version = datasets.get(DATASETS["rates"][0], {}).get("current_version_id")
    rates = [
        rate
        for rate in sp.pages("/v1/rates", city_id=city["id"])
        if rate["category"] == "water"
        and any(
            ref["dataset_version_id"] == research_rate_version for ref in rate["source_refs"]
        )
    ]
    zones = [
        z for z in sp.pages("/v1/zones", city_id=city["id"]) if z["name"] in {z[0] for z in ZONES}
    ]
    planning_versions = {
        datasets.get(DATASETS[key][0], {}).get("current_version_id")
        for key in (
            "demo_rules",
            "demo_models",
            "demo_rates",
            "demo_suitability",
            "demo_stock",
        )
    }
    scenarios, calculations, prepared, full_calculations = 0, 0, 0, 0
    exact_stock_scenarios = 0
    nonhero_ecosystem_unavailable = 0
    hero_revision = None
    hero_snapshot = None
    for zone in zones:
        for scenario in sp.pages("/v1/scenarios", city_id=city["id"], zone_id=zone["id"]):
            if scenario["name"] in {t for t, _, _ in VARIANTS}:
                scenarios += 1
                revision = sp.get(f"/v1/scenario-revisions/{scenario['current_revision_id']}")
                snapshots = sp.get(
                    "/v1/calculations", scenario_revision_id=scenario["current_revision_id"]
                )["items"]
                calculations += bool(snapshots)
                is_hero = zone["name"] == HERO_ZONE and scenario["name"] == HERO_SCENARIO
                prepared_profile = (
                    revision["synthetic_inputs"]
                    and revision["catalog_version_id"] == profile_catalog_id
                    and revision["rule_version_id"] == MVP_RULE_ID
                    and revision["model_version_id"] is not None
                    and len(revision["rate_version_ids"]) == 7
                    and revision["care_strategy"] == "custom"
                    and len(revision["custom_care_operations"]) == 12
                    and (revision["comment"] or "").startswith(
                        "SYNTHETIC TEST · Оценочный профиль MVP"
                    )
                    and planning_versions.issubset(revision["dataset_version_ids"])
                )
                if prepared_profile:
                    prepared += 1
                else:
                    problems.append(f"MVP planning profile is incomplete: {scenario['id']}")
                if revision["placements"] and all(
                    placement["stock_item_id"] in profile_stock_ids
                    for placement in revision["placements"]
                ):
                    exact_stock_scenarios += 1
                else:
                    problems.append(f"MVP exact stock is incomplete: {scenario['id']}")
                planning_snapshot = next(
                    (
                        snapshot
                        for snapshot in snapshots
                        if has_complete_mvp_planning(snapshot)
                        and (
                            has_demo_ecosystem(snapshot)
                            if is_hero
                            else not snapshot["ecosystem"]
                        )
                    ),
                    None,
                )
                if planning_snapshot is not None:
                    full_calculations += 1
                else:
                    problems.append(f"MVP full planning calculation is missing: {scenario['id']}")
                if is_hero:
                    hero_revision = revision
                    hero_snapshot = planning_snapshot
                elif (
                    ecosystem_version_id in revision["dataset_version_ids"]
                    or population_version_id in revision["dataset_version_ids"]
                ) or (
                    profile_coefficient is not None
                    and revision["coefficient_version_id"]
                    == profile_coefficient["version_id"]
                ):
                    problems.append(
                        f"MVP ecosystem profile leaked into non-hero scenario {scenario['id']}"
                    )
                elif revision["coefficient_version_id"] is None and (
                    planning_snapshot is not None and not planning_snapshot["ecosystem"]
                ):
                    nonhero_ecosystem_unavailable += 1
    if hero_revision is None:
        problems.append("MVP hero revision is missing")
    else:
        if not hero_revision["synthetic_inputs"]:
            problems.append("MVP hero is not marked synthetic")
        if hero_revision["rule_version_id"] != MVP_RULE_ID:
            problems.append("MVP hero does not freeze the estimate rule")
        if hero_revision["catalog_version_id"] != profile_catalog_id:
            problems.append("MVP hero does not freeze the suitability catalog")
        if suitability_version_id not in hero_revision["dataset_version_ids"]:
            problems.append("MVP hero does not freeze the suitability dataset version")
        if profile_coefficient is None or hero_revision["coefficient_version_id"] != (
            profile_coefficient["version_id"]
        ):
            problems.append("MVP hero does not freeze the ecosystem coefficient profile")
        if ecosystem_version_id not in hero_revision["dataset_version_ids"]:
            problems.append("MVP hero does not freeze the ecosystem dataset version")
        if population_version_id not in hero_revision["dataset_version_ids"]:
            problems.append("MVP hero does not freeze the population dataset version")
        if hero_revision["care_strategy"] != "custom" or len(
            hero_revision["custom_care_operations"]
        ) != 12:
            problems.append("MVP hero care calendar is incomplete")
    if hero_snapshot is None:
        problems.append("MVP hero complete calculation is missing")
    else:
        if hero_snapshot["cost"]["total"] is None:
            problems.append("MVP hero cost total is missing")
        if not hero_snapshot["care"]:
            problems.append("MVP hero care result is empty")
        if any(
            point["probability"] is None
            for result in hero_snapshot["survival"]
            for point in result["points"]
        ):
            problems.append("MVP hero survival estimate is incomplete")
        if not has_demo_ecosystem(hero_snapshot):
            problems.append("MVP hero ecosystem 5/10/20 indicators are incomplete")
    demo_program = next(
        (
            item
            for item in sp.pages("/v1/programs", city_id=city["id"])
            if item["name"] == "Программа озеленения Павлодара · 2027"
        ),
        None,
    )
    priority_ready = 0
    roadmap_ready = 0
    if demo_program is not None and demo_program.get("priority_result_id"):
        frozen_priority = sp.get(f"/v1/priorities/{demo_program['priority_result_id']}")
        expected_priority_sources = {
            priority_green_version_id,
            priority_soil_version_id,
        }
        contribution_sources = {
            ref["dataset_version_id"]
            for zone in frozen_priority["zones"]
            for contribution in zone["contributions"]
            for ref in contribution["source_refs"]
        }
        if (
            len(frozen_priority["zones"]) == 3
            and all(zone["score"] is not None for zone in frozen_priority["zones"])
            and expected_priority_sources <= contribution_sources
            and len(demo_program["candidate_revision_ids"]) == 9
        ):
            priority_ready = 1
        else:
            problems.append("MVP program priority result is incomplete or lacks source refs")
        roadmaps = sp.pages(f"/v1/programs/{demo_program['id']}/revisions")
        if any(
            item["solver_status"] in {"optimal", "feasible"}
            and item["selected_scenario_revision_ids"]
            and item["calculation_snapshot_ids"]
            for item in roadmaps
        ):
            roadmap_ready = 1
        else:
            problems.append("MVP optimized roadmap revision is missing")
    elif demo_program is not None:
        problems.append("MVP demo program has no frozen priority result")
    counts = {
        "datasets_published": len(published),
        "plants": len(plants),
        "plants_excluded": sum(p["sensitive_site_status"] == "excluded" for p in plants),
        "stock_offers": len(stock),
        "water_rates": len(rates),
        "zones": len(zones),
        "scenarios": scenarios,
        "scenarios_with_calculation": calculations,
        "mvp_prepared_scenarios": prepared,
        "mvp_full_calculations": full_calculations,
        "mvp_exact_stock_scenarios": exact_stock_scenarios,
        "nonhero_ecosystem_unavailable": nonhero_ecosystem_unavailable,
        "mvp_hero_complete": int(hero_snapshot is not None),
        "programs": int(demo_program is not None),
        "mvp_priority_ready": priority_ready,
        "mvp_roadmap_ready": roadmap_ready,
    }
    expected = {
        "datasets_published": 13,
        "plants": 9,
        "stock_offers": 11,
        "water_rates": 3,
        "zones": 3,
        "scenarios": 9,
        "scenarios_with_calculation": 9,
        "mvp_prepared_scenarios": 9,
        "mvp_full_calculations": 9,
        "mvp_exact_stock_scenarios": 9,
        "nonhero_ecosystem_unavailable": 8,
        "mvp_hero_complete": 1,
        "programs": 1,
        "mvp_priority_ready": 1,
        "mvp_roadmap_ready": 1,
    }
    for key, wanted in expected.items():
        if counts[key] != wanted:
            problems.append(f"{key}: {counts[key]} != {wanted}")
    return {"counts": counts, "problems": problems, "passed": not problems}


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base-url", default="http://localhost:8001")
    parser.add_argument("--city-id", default=os.environ.get("PG_DEMO_CITY_ID"))
    parser.add_argument("--license", dest="license_name", default=None)
    parser.add_argument("--check", action="store_true", help="verify only, no writes")
    args = parser.parse_args()
    clients = sign_in(args.base_url)
    cities = clients["specialist"].get("/v1/cities")["items"]
    if args.city_id:
        city = next(c for c in cities if c["id"] == args.city_id)
    elif len(cities) == 1:
        city = cities[0]
    else:
        raise SystemExit("Several cities are visible: pass --city-id")
    if not args.check:
        print(json.dumps(bootstrap(clients, city, args.license_name), ensure_ascii=False))
    result = check(clients, city)
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result["passed"] else 1)


if __name__ == "__main__":
    main()
