"""Shadow job handler: heights, result rules, deadline, cancel and retry identity (no database)."""

from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from shapely.geometry import box

from packages.domain.errors import DomainError
from packages.domain.heights import record_height
from packages.domain.shadow import Building, ShadowInputs, SunPosition, compute_shadows
from services.worker import shadow as job_module
from services.worker.shadow import Cancelled, Checkpoint, build_result, parse_request, result_id

REQUEST = {
    "scenario_revision_id": "00000000-0000-4000-8000-000000000001",
    "datetime": "2026-06-21T12:00:00+05:00",
    "grid_resolution_m": 1.0,
    "geometry_mode": "analytical_verified",
    "include_neighbor_buffer": True,
}
SUN = SunPosition(
    elevation_deg=45.0, azimuth_deg=180.0, declination_deg=0.0, equation_of_time_min=0.0
)
REF = {
    "dataset_version_id": "00000000-0000-4000-8000-0000000000aa",
    "source_record_id": None,
    "label": "SYNTHETIC TEST здания",
    "uri": None,
}


@pytest.mark.parametrize(
    ("props", "expected"),
    [
        ({"height": "12"}, (12.0, "recorded_unverified", None)),
        ({"height": "12.5 m"}, (12.5, "recorded_unverified", None)),
        ({"height": "40 ft"}, (None, "unknown", None)),
        ({"building:levels": "5"}, (None, "unknown", 5)),
        ({"height_m": 9.0, "height_basis": "measured", "building:levels": 3}, (9.0, "measured", 3)),
        ({"height_m": 9.0, "height_basis": "unknown"}, (None, "unknown", None)),
        ({"height": True}, (None, "unknown", None)),
        ({}, (None, "unknown", None)),
    ],
)
def test_record_height_never_invents_a_value(props, expected):
    assert record_height(props) == expected


def inputs(buildings=(), has_dataset=True, synthetic=True):
    return {
        "zone": box(0, 10, 40, 40),
        "sun": SUN,
        "buildings": list(buildings),
        "trees": [],
        "has_buildings_dataset": has_dataset,
        "source_refs": [REF],
        "synthetic": synthetic,
    }


def run(inp):
    return compute_shadows(
        ShadowInputs(inp["zone"], inp["buildings"], [], "analytical_verified", 1.0), SUN
    )


def test_result_complete_with_exact_shade_area_and_artifact():
    inp = inputs([Building("b1", box(0, 0, 10, 10), 10.0, "measured")])
    payload, artifact = build_result("r1", "rev", inp, run(inp), REQUEST, "2026-06-21T07:00:00Z")
    assert payload["status"] == "complete" and payload["data_gaps"] == []
    metric = payload["metrics"][0]
    assert (metric["key"], metric["unit"], metric["value"], metric["status"]) == (
        "shade_area",
        "m2",
        100.0,
        "synthetic",
    )
    assert metric["missing_reason"] is None and metric["source_refs"] == [REF]
    assert payload["artifact_url"] == "/v1/spatial-results/r1/artifact"
    assert artifact["metadata"]["sun"]["elevation_deg"] == 45.0
    assert artifact["features"][0]["geometry"]["type"] in {"Polygon", "MultiPolygon"}


def test_missing_buildings_dataset_is_unknown_not_zero():
    inp = inputs(has_dataset=False)
    payload, _ = build_result("r1", "rev", inp, run(inp), REQUEST, "2026-06-21T07:00:00Z")
    metric = payload["metrics"][0]
    assert payload["status"] == "partial"
    assert metric["value"] is None and metric["status"] == "unavailable"
    assert metric["missing_reason"]["code"] == "buildings_dataset_missing"


def test_buildings_without_usable_heights_are_unknown_and_listed():
    inp = inputs(
        [
            Building("b1", box(0, 0, 10, 10), None, "unknown"),
            Building("b2", box(12, 0, 20, 8), 9.0, "recorded_unverified"),
        ]
    )
    payload, _ = build_result("r1", "rev", inp, run(inp), REQUEST, "2026-06-21T07:00:00Z")
    codes = [g["code"] for g in payload["data_gaps"]]
    assert payload["status"] == "partial" and payload["metrics"][0]["value"] is None
    assert codes[0] == "building_heights_missing"
    assert {
        "shadow_input_excluded:height_unknown",
        "shadow_input_excluded:height_basis_not_allowed",
    } <= set(codes)
    excluded = [g for g in payload["data_gaps"] if g["code"].startswith("shadow_input_excluded")]
    assert all(not g["blocking"] for g in excluded)


def test_no_building_in_reach_is_a_real_zero():
    inp = inputs([])
    payload, _ = build_result("r1", "rev", inp, run(inp), REQUEST, "2026-06-21T07:00:00Z")
    assert payload["status"] == "complete" and payload["metrics"][0]["value"] == 0.0


def test_sun_below_horizon_is_unavailable_without_artifact():
    payload, artifact = build_result("r1", "rev", inputs(), None, REQUEST, "2026-06-21T07:00:00Z")
    assert (
        payload["status"] == "unavailable" and artifact is None and payload["artifact_url"] is None
    )
    assert payload["metrics"][0]["missing_reason"]["code"] == "sun_below_horizon"


def test_request_needs_an_offset():
    with pytest.raises(DomainError) as e:
        parse_request({**REQUEST, "datetime": "2026-06-21T12:00:00"})
    assert e.value.code == "shadow_datetime_naive"
    assert (
        parse_request({**REQUEST, "datetime": "2026-06-21T07:00:00Z"}).utcoffset().total_seconds()
        == 0
    )


def test_checkpoint_deadline_and_cancel():
    t = [0.0]
    renewals = []

    def renew(progress):
        renewals.append(progress)
        return len(renewals) < 2

    cp = Checkpoint(renew, clock=lambda: t[0], deadline_s=100)
    cp(0.1)  # no heartbeat yet
    t[0] = 25
    cp(0.3)  # heartbeat, still alive
    t[0] = 50
    with pytest.raises(Cancelled):
        cp(0.5)  # second heartbeat sees cancel_requested
    assert renewals == [0.3, 0.5]
    late = Checkpoint(lambda p: True, clock=lambda: t[0], deadline_s=10)
    t[0] = 200
    with pytest.raises(DomainError) as e:
        late(0.9)
    assert e.value.code == "shadow_timeout"


def test_result_id_is_stable_per_job():
    assert result_id("job-1") == result_id("job-1") != result_id("job-2")


def test_run_shadow_cancel_ends_cancelled_without_storing(monkeypatch):
    events = []
    job = SimpleNamespace(
        id="job-1",
        state="running",
        request_payload=REQUEST,
        input_revision_id="rev",
        city_id="city",
    )

    @contextmanager
    def session():
        yield SimpleNamespace(begin=lambda: _noop())

    @contextmanager
    def _noop():
        yield

    jobs = SimpleNamespace(
        leased=lambda db, job_id, token: job,
        state=lambda db, j, target, **c: events.append(("state", c.get("phase"))),
        heartbeat=lambda db, job_id, token: False,  # owner asked to cancel
        complete=lambda db, job_id, token, persist: events.append(("complete", persist(db, job))),
    )
    monkeypatch.setattr(
        job_module,
        "load_inputs",
        lambda db, rid, req: inputs([Building("b1", box(0, 0, 10, 10), 10.0, "measured")]),
    )
    monkeypatch.setattr(job_module, "HEARTBEAT_S", 0.0)
    job_module.run_shadow("job-1", "tok", session, jobs, lambda: "2026-06-21T07:00:00Z")
    # complete() with a no-op persist: jobs.complete turns cancel_requested into cancelled.
    assert ("complete", None) in events
