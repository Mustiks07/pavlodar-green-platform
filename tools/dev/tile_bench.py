"""Measure authorized MVT latency at the client concurrency cap and a 32-request burst."""

import asyncio
import json
import math
import statistics
import time
from pathlib import Path

import httpx

from services.api.research import CITY_ID
from tools.dev.smoke_oidc import login

ROOT = Path(__file__).parents[2]
BASE = "http://127.0.0.1:8001"


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]


async def timed_batch(client, paths):
    started = time.perf_counter()
    responses = await asyncio.gather(*(client.get(path) for path in paths))
    elapsed = round((time.perf_counter() - started) * 1000, 1)
    assert {response.status_code for response in responses} == {200}
    return elapsed


async def measure(cookie, template):
    paths = [
        template.replace("{z}", "13")
        .replace("{x}", str(5830 + index % 8))
        .replace("{y}", str(2690 + index // 8))
        for index in range(32)
    ]
    limits = httpx.Limits(max_connections=32, max_keepalive_connections=32)
    async with httpx.AsyncClient(
        base_url=BASE,
        cookies={"pavlodar_session": cookie},
        timeout=30,
        limits=limits,
    ) as client:
        await timed_batch(client, paths[:4])
        four = [await timed_batch(client, paths[:4]) for _ in range(7)]
        burst = [await timed_batch(client, paths) for _ in range(5)]
    return four, burst


def summary(values):
    return {
        "runs_ms": values,
        "p50_ms": statistics.median(values),
        "p95_ms": percentile(values, 0.95),
        "max_ms": max(values),
    }


def main():
    with httpx.Client(base_url=BASE, follow_redirects=False, timeout=30) as client:
        login(client, "admin")
        response = client.get("/v1/map/layers", params={"city_id": CITY_ID, "limit": 200})
        response.raise_for_status()
        layer = next(item for item in response.json()["items"] if item["source_type"] == "mvt")
        cookie = client.cookies.get("pavlodar_session")
    four, burst = asyncio.run(measure(cookie, layer["source_url"]))
    result = {
        "passed": summary(four)["p95_ms"] < 250,
        "scope": "Local Docker HTTP/1.1, real OIDC session and authorized empty/non-empty MVT requests; not a production SLA",
        "api_workers": 4,
        "client_concurrency_cap": 4,
        "parallel_4": summary(four),
        "parallel_32_burst": summary(burst),
        "organizer_data_received": False,
    }
    path = ROOT / "docs/evidence/map_tile_performance.json"
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    assert result["passed"]


if __name__ == "__main__":
    main()
