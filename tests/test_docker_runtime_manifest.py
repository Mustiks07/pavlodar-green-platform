from pathlib import Path


def test_worker_image_contains_every_runtime_package():
    dockerfile = (Path(__file__).parents[1] / "infra" / "Dockerfile").read_text()
    for package in ("domain", "geo", "optimization"):
        assert f"COPY packages/{package} ./packages/{package}" in dockerfile
