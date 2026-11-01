import io
import stat
import zipfile

import pytest

from services.worker.import_parsers import _safe_members


def archive_with(entries):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content, external_attr in entries:
            info = zipfile.ZipInfo(name)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = external_attr
            archive.writestr(info, content)
    stream.seek(0)
    return zipfile.ZipFile(stream)


@pytest.mark.parametrize("name", ["../x.shp", "/x.shp", "C:/x.shp", "folder/../x.shp"])
def test_archive_rejects_unsafe_paths(name):
    with archive_with([(name, b"x", 0)]) as archive, pytest.raises(
        ValueError, match="unsafe path"
    ):
        _safe_members(archive)


def test_archive_rejects_case_folded_duplicates_and_symlinks():
    with archive_with(
        [("x.shp", b"x", 0), ("X.SHP", b"x", 0)]
    ) as archive, pytest.raises(ValueError, match="duplicate"):
        _safe_members(archive)
    symlink = (stat.S_IFLNK | 0o777) << 16
    with archive_with([("x.shp", b"target", symlink)]) as archive, pytest.raises(
        ValueError, match="symbolic"
    ):
        _safe_members(archive)


def test_archive_rejects_compression_bombs_and_entry_floods():
    with archive_with([("x.dbf", b"0" * 100_000, 0)]) as archive, pytest.raises(
        ValueError, match="compression ratio"
    ):
        _safe_members(archive)
    entries = [(f"{index}.txt", b"x", 0) for index in range(129)]
    with archive_with(entries) as archive, pytest.raises(ValueError, match="128 entries"):
        _safe_members(archive)
