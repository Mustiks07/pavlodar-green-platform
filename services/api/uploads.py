"""Authenticated streaming upload data-plane; filenames never become filesystem paths."""

import hashlib
import os
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import anyio
from fastapi import Request
from fastapi.responses import Response
from sqlalchemy import select

from packages.domain.errors import DomainError
from services.api.config import settings
from services.api.db import session
from services.api.models import Dataset, Upload
from services.api.security import authenticate
from services.api.use_cases import found


def upload_path(storage_key):
    root = Path(settings().upload_root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    path = (root / f"{storage_key}.bin").resolve()
    if not path.is_relative_to(root):
        raise DomainError(500, "upload_storage_invalid", "Upload storage path is invalid")
    return path


async def put_upload_content(request: Request):
    upload_id = request.path_params["upload_id"]
    with session() as db:
        access = authenticate(db, request)
        access.role("specialist")
        access.mutation(request)
        upload = found(db.get(Upload, upload_id))
        dataset = found(db.get(Dataset, upload.dataset_id))
        access.dataset(dataset)
        if upload.owner_id != access.user.id and access.level < 2:
            raise DomainError(404, "not_found", "Object not found")
        if upload.state in {"stored", "consumed"}:
            return Response(status_code=204)
        if upload.expires_at <= datetime.now(UTC):
            raise DomainError(410, "upload_ticket_expired", "Upload ticket has expired")
        expected_type = upload.content_type
        expected_size = upload.byte_size
        expected_hash = upload.sha256
        storage_key = upload.storage_key

    key = request.headers.get("idempotency-key", "")
    if not 8 <= len(key) <= 128:
        raise DomainError(422, "invalid_parameter", "Invalid Idempotency-Key")
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != expected_type:
        raise DomainError(415, "upload_content_type_mismatch", "Content-Type does not match ticket")
    if request.headers.get("content-length"):
        try:
            declared = int(request.headers["content-length"])
        except ValueError:
            raise DomainError(422, "invalid_parameter", "Invalid Content-Length") from None
        if declared != expected_size:
            raise DomainError(422, "upload_size_mismatch", "Content-Length does not match ticket")

    final = upload_path(storage_key)
    temporary = final.with_name(final.name + f".{uuid4()}.part")
    digest = hashlib.sha256()
    size = 0
    try:
        async with await anyio.open_file(temporary, "xb") as stream:
            async for chunk in request.stream():
                size += len(chunk)
                if size > expected_size:
                    raise DomainError(413, "upload_size_mismatch", "Upload exceeds ticket size")
                digest.update(chunk)
                await stream.write(chunk)
        if size != expected_size or digest.hexdigest() != expected_hash:
            raise DomainError(422, "upload_checksum_mismatch", "Upload size or SHA-256 mismatch")
        os.chmod(temporary, 0o600)
        os.replace(temporary, final)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise

    with session() as db, db.begin():
        upload = found(db.scalar(select(Upload).where(Upload.id == upload_id).with_for_update()))
        if upload.state == "ticketed":
            upload.state = "stored"
            upload.stored_at = datetime.now(UTC)
    return Response(status_code=204)
