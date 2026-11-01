"""Authorized immutable PMTiles delivery with bounded single-range responses."""

import re
from pathlib import Path
from uuid import UUID

from fastapi import Request
from fastapi.responses import Response, StreamingResponse
from sqlalchemy import select

from packages.domain.errors import DomainError
from services.api.config import settings
from services.api.db import session
from services.api.models import Dataset, DatasetVersion, MapArchiveArtifact, MapLayer
from services.api.security import authenticate

RANGE_PATTERN = re.compile(r"bytes=(\d*)-(\d*)$")
CHUNK_SIZE = 64 * 1024


def _archive_path(storage_key: str) -> Path:
    root = Path(settings().tile_root).resolve()
    path = (root / storage_key).resolve()
    if root not in path.parents:
        raise DomainError(503, "archive_storage_invalid", "Archive storage key is invalid")
    return path


def _parse_range(value: str, size: int) -> tuple[int, int]:
    if len(value) > 128:
        raise DomainError(
            416,
            "range_not_satisfiable",
            "Byte range header is too long",
            headers={"Content-Range": f"bytes */{size}"},
        )
    match = RANGE_PATTERN.fullmatch(value.strip())
    if not match or "," in value:
        raise DomainError(
            416,
            "range_not_satisfiable",
            "Only one byte range is supported",
            headers={"Content-Range": f"bytes */{size}"},
        )
    first, last = match.groups()
    if not first and not last:
        raise DomainError(
            416,
            "range_not_satisfiable",
            "Byte range is empty",
            headers={"Content-Range": f"bytes */{size}"},
        )
    if not first:
        suffix = int(last)
        if suffix <= 0:
            raise DomainError(
                416,
                "range_not_satisfiable",
                "Suffix range is empty",
                headers={"Content-Range": f"bytes */{size}"},
            )
        return max(0, size - suffix), size - 1
    start = int(first)
    end = int(last) if last else size - 1
    if start >= size or end < start:
        raise DomainError(
            416,
            "range_not_satisfiable",
            "Byte range is outside the archive",
            headers={"Content-Range": f"bytes */{size}"},
        )
    return start, min(end, size - 1)


def _stream(path: Path, start: int, length: int):
    with path.open("rb") as source:
        source.seek(start)
        remaining = length
        while remaining:
            chunk = source.read(min(CHUNK_SIZE, remaining))
            if not chunk:
                raise OSError("Archive ended before registered byte_size")
            remaining -= len(chunk)
            yield chunk


def get_map_archive(request: Request):
    try:
        layer_id = str(UUID(request.path_params["layer_id"]))
    except (ValueError, TypeError):
        raise DomainError(422, "invalid_parameter", "Некорректный идентификатор слоя") from None

    with session() as db:
        access = authenticate(db, request)
        layer = db.get(MapLayer, layer_id)
        if not layer:
            raise DomainError(404, "not_found", "Объект не найден")
        dataset = db.get(Dataset, layer.dataset_id)
        if not dataset:
            raise DomainError(404, "not_found", "Объект не найден")
        access.dataset(dataset)
        version = db.get(DatasetVersion, layer.dataset_version_id)
        artifact = db.scalar(
            select(MapArchiveArtifact).where(MapArchiveArtifact.map_layer_id == layer.id)
        )
        if (
            not artifact
            or dataset.access_level != "public"
            or dataset.current_version_id != layer.dataset_version_id
            or not version
            or version.status != "published"
            or artifact.dataset_version_id != layer.dataset_version_id
        ):
            raise DomainError(404, "not_found", "Архив слоя недоступен")
        storage_key = artifact.storage_key
        registered_size = artifact.byte_size
        etag = f'"{artifact.sha256}"'

    path = _archive_path(storage_key)
    if not path.is_file() or path.stat().st_size != registered_size:
        raise DomainError(503, "archive_storage_unavailable", "Archive bytes are unavailable")
    size = registered_size
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=31536000, immutable",
        "ETag": etag,
        "Content-Disposition": f'inline; filename="{layer_id}.pmtiles"',
    }
    range_value = request.headers.get("range")
    if range_value and request.headers.get("if-range") not in {None, etag}:
        range_value = None
    if not range_value and request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    if range_value:
        start, end = _parse_range(range_value, size)
        length = end - start + 1
        headers.update(
            {
                "Content-Range": f"bytes {start}-{end}/{size}",
                "Content-Length": str(length),
            }
        )
        return StreamingResponse(
            _stream(path, start, length),
            status_code=206,
            media_type="application/vnd.pmtiles",
            headers=headers,
        )
    headers["Content-Length"] = str(size)
    return StreamingResponse(
        _stream(path, 0, size), media_type="application/vnd.pmtiles", headers=headers
    )
