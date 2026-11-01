"""Crash-isolated KML and Shapefile readers with strict archive and geometry bounds."""

import json
import math
import os
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

import shapefile
from defusedxml import ElementTree as SafeElementTree
from jsonschema import ValidationError
from shapely import get_num_coordinates
from shapely.geometry import shape

from packages.domain.contracts import validate

MAX_RECORDS = 100_000
MAX_ARCHIVE_ENTRIES = 128
MAX_ARCHIVE_UNCOMPRESSED = 200_000_000
MAX_ARCHIVE_ENTRY = 100_000_000
MAX_COMPRESSION_RATIO = 100
MAX_GEOMETRY_COORDINATES = 100_000
MAX_TOTAL_COORDINATES = 2_000_000
MAX_PROPERTY_BYTES = 1_000_000
PARSER_TIMEOUT_SECONDS = 60
MAX_RESULT_BYTES = 250_000_000


def _issue(code, message, source=None, action=None):
    return {
        "code": code,
        "severity": "error",
        "source_record_id": source,
        "message": message,
        "geometry": None,
        "suggested_action": action,
    }


def _mapping(request, fields):
    pairs = request["field_mapping"]
    sources = [pair["source_field"] for pair in pairs]
    targets = [pair["target_field"] for pair in pairs]
    if len(sources) != len(set(sources)) or len(targets) != len(set(targets)):
        raise ValueError("field_mapping contains duplicate source or target fields")
    missing = sorted(set(sources) - set(fields))
    if missing:
        raise ValueError("field_mapping source fields missing: " + ", ".join(missing))
    return pairs


def _mapped(properties, pairs):
    if not pairs:
        return properties
    return {pair["target_field"]: properties.get(pair["source_field"]) for pair in pairs}


def _checked_record(source, geometry, properties, coordinate_state):
    validate("Geometry", geometry)
    shaped = shape(geometry)
    if shaped.is_empty or not shaped.is_valid:
        raise ValueError("geometry is empty or topologically invalid")
    west, south, east, north = shaped.bounds
    if not all(math.isfinite(value) for value in shaped.bounds) or not (
        -180 <= west <= east <= 180 and -90 <= south <= north <= 90
    ):
        raise ValueError("geometry coordinates are outside EPSG:4326 bounds")
    count = int(get_num_coordinates(shaped))
    if count > MAX_GEOMETRY_COORDINATES:
        raise ValueError(f"geometry exceeds {MAX_GEOMETRY_COORDINATES} coordinates")
    coordinate_state[0] += count
    if coordinate_state[0] > MAX_TOTAL_COORDINATES:
        raise ValueError(f"file exceeds {MAX_TOTAL_COORDINATES} coordinates")
    if len(properties) > 256 or len(json.dumps(properties, ensure_ascii=False)) > MAX_PROPERTY_BYTES:
        raise ValueError("feature properties exceed parser limits")
    return {"source_record_id": source, "geometry": geometry, "properties": properties}


def _coords(text):
    result = []
    for token in (text or "").replace("\n", " ").split():
        values = token.split(",")
        if len(values) < 2:
            raise ValueError("KML coordinate must contain longitude and latitude")
        lon, lat = float(values[0]), float(values[1])
        result.append([lon, lat])
    return result


def _descendant(element, local_name):
    return next((item for item in element.iter() if item.tag.rsplit("}", 1)[-1] == local_name), None)


def _kml_geometry(placemark):
    point = _descendant(placemark, "Point")
    line = _descendant(placemark, "LineString")
    polygon = _descendant(placemark, "Polygon")
    kinds = sum(item is not None for item in (point, line, polygon))
    if kinds != 1:
        raise ValueError("KML Placemark must contain exactly one Point, LineString or Polygon")
    if point is not None:
        values = _coords(_descendant(point, "coordinates").text)
        if len(values) != 1:
            raise ValueError("KML Point must contain one coordinate")
        return {"type": "Point", "coordinates": values[0]}
    if line is not None:
        return {
            "type": "LineString",
            "coordinates": _coords(_descendant(line, "coordinates").text),
        }
    rings = []
    for boundary_name in ("outerBoundaryIs", "innerBoundaryIs"):
        for boundary in (
            item for item in polygon.iter() if item.tag.rsplit("}", 1)[-1] == boundary_name
        ):
            coordinates = _descendant(boundary, "coordinates")
            rings.append(_coords(coordinates.text if coordinates is not None else None))
    if not rings:
        raise ValueError("KML Polygon has no rings")
    return {"type": "Polygon", "coordinates": rings}


def parse_kml(path, request):
    if request["source_crs"].upper() not in {"EPSG:4326", "CRS84", "OGC:CRS84"}:
        return [], [_issue("crs_transform_not_available", "KML parser accepts only WGS84")]
    root = SafeElementTree.fromstring(path.read_bytes())
    placemarks = [item for item in root.iter() if item.tag.rsplit("}", 1)[-1] == "Placemark"]
    if len(placemarks) > MAX_RECORDS:
        raise ValueError(f"KML exceeds {MAX_RECORDS} placemarks")
    raw, issues, fields, coordinate_state = [], [], set(), [0]
    for index, placemark in enumerate(placemarks):
        source = placemark.attrib.get("id", str(index))
        try:
            properties = {}
            name = _descendant(placemark, "name")
            if name is not None and (name.text or "").strip():
                properties["name"] = name.text.strip()
            for item in placemark.iter():
                local = item.tag.rsplit("}", 1)[-1]
                if local == "Data" and item.attrib.get("name"):
                    value = _descendant(item, "value")
                    properties[item.attrib["name"]] = value.text if value is not None else None
                elif local == "SimpleData" and item.attrib.get("name"):
                    properties[item.attrib["name"]] = item.text
            fields.update(properties)
            raw.append(
                _checked_record(source, _kml_geometry(placemark), properties, coordinate_state)
            )
        except (TypeError, ValueError, ValidationError) as error:
            issues.append(_issue("record_invalid", f"KML record {source}: {error}", source))
    pairs = _mapping(request, fields)
    for record in raw:
        record["properties"] = _mapped(record["properties"], pairs)
    return raw, issues


def _safe_members(archive):
    members = archive.infolist()
    if len(members) > MAX_ARCHIVE_ENTRIES:
        raise ValueError(f"ZIP exceeds {MAX_ARCHIVE_ENTRIES} entries")
    total = 0
    seen = set()
    for member in members:
        normalized = member.filename.replace("\\", "/")
        parts = PurePosixPath(normalized).parts
        if (
            not normalized
            or not parts
            or normalized.startswith("/")
            or any(part in {"", ".", ".."} for part in parts)
            or ":" in parts[0]
        ):
            raise ValueError("ZIP contains an unsafe path")
        folded = normalized.casefold()
        if folded in seen:
            raise ValueError("ZIP contains duplicate paths")
        seen.add(folded)
        if member.flag_bits & 0x1:
            raise ValueError("Encrypted ZIP entries are not accepted")
        if (member.external_attr >> 16) & 0o170000 == 0o120000:
            raise ValueError("ZIP symbolic links are not accepted")
        if member.file_size > MAX_ARCHIVE_ENTRY:
            raise ValueError(f"ZIP entry exceeds {MAX_ARCHIVE_ENTRY} bytes")
        ratio = member.file_size / max(member.compress_size, 1)
        if ratio > MAX_COMPRESSION_RATIO:
            raise ValueError("ZIP compression ratio exceeds safety limit")
        total += member.file_size
    if total > MAX_ARCHIVE_UNCOMPRESSED:
        raise ValueError(f"ZIP exceeds {MAX_ARCHIVE_UNCOMPRESSED} uncompressed bytes")
    return members


def parse_shp_zip(path, request):
    if request["source_crs"].upper() not in {"EPSG:4326", "CRS84", "OGC:CRS84"}:
        return [], [_issue("crs_transform_not_available", "Shapefile parser accepts only WGS84")]
    with zipfile.ZipFile(path) as archive:
        members = _safe_members(archive)
        by_name = {member.filename.replace("\\", "/").lower(): member for member in members}
        shp_names = [name for name in by_name if name.endswith(".shp")]
        if len(shp_names) != 1:
            raise ValueError("ZIP must contain exactly one .shp dataset")
        base = shp_names[0][:-4]
        required = {extension: by_name.get(base + extension) for extension in (".shp", ".shx", ".dbf")}
        if any(member is None for member in required.values()):
            raise ValueError("Shapefile ZIP requires matching .shp, .shx and .dbf entries")
        encoding = "utf-8"
        cpg = by_name.get(base + ".cpg")
        if cpg is not None:
            declared = archive.read(cpg).decode("ascii", "strict").strip().upper()
            encodings = {"UTF-8": "utf-8", "65001": "utf-8", "CP1251": "cp1251", "WINDOWS-1251": "cp1251", "1251": "cp1251"}
            if declared not in encodings:
                raise ValueError("Unsupported Shapefile .cpg encoding")
            encoding = encodings[declared]
        reader = shapefile.Reader(
            shp=archive.open(required[".shp"]),
            shx=archive.open(required[".shx"]),
            dbf=archive.open(required[".dbf"]),
            encoding=encoding,
            encodingErrors="strict",
        )
        try:
            if reader.numRecords > MAX_RECORDS:
                raise ValueError(f"Shapefile exceeds {MAX_RECORDS} records")
            fields = [field[0] for field in reader.fields[1:]]
            pairs = _mapping(request, fields)
            records, issues, coordinate_state = [], [], [0]
            for index, shape_record in enumerate(reader.iterShapeRecords()):
                source = str(index)
                try:
                    geometry = json.loads(json.dumps(shape_record.shape.__geo_interface__))
                    properties = dict(zip(fields, shape_record.record, strict=True))
                    records.append(
                        _checked_record(
                            source, geometry, _mapped(properties, pairs), coordinate_state
                        )
                    )
                except (TypeError, ValueError, ValidationError) as error:
                    issues.append(
                        _issue("record_invalid", f"Shapefile record {source}: {error}", source)
                    )
            return records, issues
        finally:
            reader.close()


def _child(path, request, output_path):
    try:
        parser = parse_kml if request["format"] == "kml" else parse_shp_zip
        records, issues = parser(Path(path), request)
        result = {"ok": True, "records": records, "issues": issues}
    except Exception as error:  # noqa: BLE001 - parser child is a crash/error boundary
        result = {"ok": False, "error": f"{type(error).__name__}: {str(error)[:1000]}"}
    Path(output_path).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")


def _resource_limits():
    """Bound production Linux children; Windows development still has byte/time limits."""
    try:
        import resource
    except ImportError:
        return
    gibibyte = 1024 * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_AS, (gibibyte, gibibyte))
    resource.setrlimit(resource.RLIMIT_CPU, (PARSER_TIMEOUT_SECONDS, PARSER_TIMEOUT_SECONDS))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_RESULT_BYTES, MAX_RESULT_BYTES))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))


def _child_main(arguments):
    if len(arguments) != 3:
        raise SystemExit(2)
    path, request_path, output_path = arguments
    _resource_limits()
    request = json.loads(Path(request_path).read_text(encoding="utf-8"))
    _child(path, request, output_path)


def parse_isolated(path, request):
    """Run attack-prone archive/XML parsers in a disposable subprocess."""
    with tempfile.NamedTemporaryFile(
        prefix="pavlodar-parser-", suffix=".json", delete=False
    ) as output:
        output_path = Path(output.name)
    with tempfile.NamedTemporaryFile(
        prefix="pavlodar-parser-request-", suffix=".json", mode="w", encoding="utf-8", delete=False
    ) as request_file:
        json.dump(request, request_file, ensure_ascii=False)
        request_path = Path(request_file.name)
    root = Path(__file__).resolve().parents[2]
    environment = {
        key: value
        for key in ("PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP")
        if (value := os.environ.get(key))
    }
    environment["PYTHONPATH"] = str(root)
    try:
        try:
            completed = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "services.worker.import_parsers",
                    str(path),
                    str(request_path),
                    str(output_path),
                ],
                cwd=root,
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=PARSER_TIMEOUT_SECONDS + 5,
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            raise ValueError("Parser timed out") from error
        if completed.returncode != 0 or not output_path.is_file():
            raise ValueError("Parser process failed")
        if output_path.stat().st_size > MAX_RESULT_BYTES:
            raise ValueError("Parser result exceeds safety limit")
        result = json.loads(output_path.read_text(encoding="utf-8"))
        if not result.get("ok"):
            raise ValueError(result.get("error", "Parser failed"))
        return result["records"], result["issues"]
    finally:
        request_path.unlink(missing_ok=True)
        output_path.unlink(missing_ok=True)


if __name__ == "__main__":
    _child_main(sys.argv[1:])
