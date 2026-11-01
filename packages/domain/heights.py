"""Building height of a published record with its basis (ADR-004 R6/§6). No defaults.

- Canonical fields height_m + height_basis, when the publisher declared them, are used as is.
- An OSM-style `height` tag in metres is a recorded value: recorded_unverified.
- `building:levels` is kept as floors, but no height is derived from it: floors x storey height
  needs an accepted storey-height coefficient, which does not exist yet.
Anything else is unknown.
"""

import math
import re

BASES = {"measured", "recorded_unverified", "floors_estimate", "visual_placeholder", "unknown"}
_METRES = re.compile(r"^\s*(\d+(?:[.,]\d+)?)\s*(m|м|meters|metres)?\s*$", re.IGNORECASE)


def _number(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        try:
            number = float(value)
        except (OverflowError, ValueError):
            return None
        return number if math.isfinite(number) else None
    if isinstance(value, str):
        match = _METRES.match(value)
        if match:
            return float(match.group(1).replace(",", "."))
    return None


def _floors(value):
    number = _number(value)
    if number is None or number <= 0 or number != int(number):
        return None
    return int(number)


def record_height(properties: dict) -> tuple[float | None, str, int | None]:
    """(height_m, height_basis, floors) for one record's properties."""
    floors = _floors(properties.get("floors")) or _floors(properties.get("building:levels"))
    raw_declared = properties.get("height_m")
    declared = _number(raw_declared) if isinstance(raw_declared, int | float) else None
    basis = properties.get("height_basis")
    if declared is not None and declared > 0 and basis in BASES - {"unknown"}:
        return declared, basis, floors
    recorded = _number(properties.get("height"))
    if recorded is not None and recorded > 0:
        return recorded, "recorded_unverified", floors
    return None, "unknown", floors
