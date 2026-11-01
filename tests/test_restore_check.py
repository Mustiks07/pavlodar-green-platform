import hashlib
import io
import tarfile

import pytest

from tools.dev.restore_check import restore_volume, verify_file


def archive_bytes(name: str, payload: bytes) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        info = tarfile.TarInfo(name)
        info.size = len(payload)
        archive.addfile(info, io.BytesIO(payload))
    return output.getvalue()


def test_restore_volume_and_verify_exact_file(tmp_path):
    payload = b"immutable upload bytes"
    restore_volume(archive_bytes("nested/upload.bin", payload), tmp_path)

    verify_file(
        tmp_path,
        "nested/upload.bin",
        hashlib.sha256(payload).hexdigest(),
        len(payload),
    )


def test_verify_file_rejects_storage_key_outside_volume(tmp_path):
    with pytest.raises(AssertionError, match="escaped its volume"):
        verify_file(tmp_path, "../outside.bin", "0" * 64, 0)


def test_restore_volume_rejects_parent_traversal(tmp_path):
    with pytest.raises((tarfile.TarError, ValueError)):
        restore_volume(archive_bytes("../outside.bin", b"no"), tmp_path)
