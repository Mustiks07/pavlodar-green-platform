"""Authorized local address search over accepted, versioned source records."""

import base64
import binascii
import json

from sqlalchemy import text

from packages.domain.errors import DomainError, gap
from services.api.models import Dataset


def normalize_query(value: str) -> str:
    return " ".join(value.casefold().replace("ё", "е").split())


def _cursor_context(access, city_id, query, versions):
    from services.api.use_cases import canonical_hash

    return canonical_hash(
        {
            "operation": "searchAddresses",
            "user": access.user.id,
            "city_id": city_id,
            "q": query,
            "versions": sorted(versions),
        }
    )


def _decode_cursor(value, context):
    if not value:
        return 0
    try:
        payload = json.loads(base64.urlsafe_b64decode(value.encode()))
        offset = int(payload["offset"])
        if payload["context"] != context or not 0 <= offset <= 10_000:
            raise ValueError()
        return offset
    except (
        ValueError,
        KeyError,
        TypeError,
        UnicodeDecodeError,
        binascii.Error,
        json.JSONDecodeError,
    ):
        raise DomainError(422, "invalid_cursor", "Cursor does not match this query") from None


def _encode_cursor(offset, context):
    return base64.urlsafe_b64encode(
        json.dumps({"offset": offset, "context": context}, separators=(",", ":")).encode()
    ).decode()


ADDRESS_QUERY = text(
    """
    WITH ranked AS (
      SELECT
        ae.id,ae.dataset_version_id,ae.source_record_id,ae.label,ae.confidence,
        ST_X(ae.position) AS lon,ST_Y(ae.position) AS lat,
        d.payload->>'name' AS dataset_name,d.payload->>'source_uri' AS source_uri,
        CASE
          WHEN :query='' THEN 0
          WHEN ae.search_text=:query THEN 0
          WHEN starts_with(ae.search_text,:query) THEN 1
          WHEN position(:query in ae.search_text)>0 THEN 2
          ELSE 3
        END AS bucket,
        CASE WHEN :query='' THEN 0 ELSE similarity(ae.search_text,:query) END AS score
      FROM address_entries ae
      JOIN datasets d ON d.id=ae.dataset_id
      WHERE ae.city_id=:city_id
        AND ae.dataset_version_id=ANY(CAST(:versions AS uuid[]))
        AND (
          :query='' OR position(:query in ae.search_text)>0 OR ae.search_text % :query
        )
    )
    SELECT * FROM ranked
    ORDER BY bucket,score DESC,label,id
    OFFSET :offset LIMIT :fetch
    """
)


def search_addresses(db, access, params):
    city_id = params["city_id"]
    access.city(city_id)
    accessible_versions = []
    datasets = db.scalars(
        text(
            """
            SELECT id FROM datasets
            WHERE city_id=:city_id AND current_version_id IS NOT NULL
            ORDER BY id
            """
        ),
        {"city_id": city_id},
    )
    for dataset_id in datasets:
        dataset = db.get(Dataset, str(dataset_id))
        try:
            access.dataset(dataset)
        except DomainError as error:
            if error.status in {403, 404}:
                continue
            raise
        accessible_versions.append(dataset.current_version_id)

    available = bool(accessible_versions) and db.scalar(
        text(
            "SELECT EXISTS(SELECT 1 FROM address_entries "
            "WHERE dataset_version_id=ANY(CAST(:versions AS uuid[])))"
        ),
        {"versions": accessible_versions},
    )
    if not available:
        raise DomainError(
            503,
            "address_index_unavailable",
            "No accepted local address index is available for this city",
            blockers=[
                gap(
                    "address_dataset_missing",
                    "Нужен опубликованный локальный адресный набор с лицензией и provenance",
                    "DR-08",
                )
            ],
        )

    query = normalize_query(params.get("q", ""))
    context = _cursor_context(access, city_id, query, accessible_versions)
    offset = _decode_cursor(params.get("cursor"), context)
    limit = int(params.get("limit", 50))
    rows = db.execute(
        ADDRESS_QUERY,
        {
            "city_id": city_id,
            "versions": accessible_versions,
            "query": query,
            "offset": offset,
            "fetch": limit + 1,
        },
    ).mappings().all()
    items = [
        {
            "id": str(row["id"]),
            "label": row["label"],
            "position": {"type": "Point", "coordinates": [row["lon"], row["lat"]]},
            "source_ref": {
                "dataset_version_id": str(row["dataset_version_id"]),
                "source_record_id": row["source_record_id"],
                "label": row["dataset_name"],
                "uri": row["source_uri"],
            },
            "confidence": row["confidence"],
        }
        for row in rows[:limit]
    ]
    return {
        "items": items,
        "next_cursor": _encode_cursor(offset + limit, context) if len(rows) > limit else None,
    }
