import json

import pytest
from jsonschema import ValidationError

from packages.domain.contracts import OPENAPI, ROOT, validate
from services.api.auth import safe_return_to
from services.api.main import IMPLEMENTED, app


@pytest.mark.parametrize(
    "path", sorted((ROOT / "contracts/fixtures").glob("*.json")), ids=lambda p: p.name
)
def test_canonical_fixtures(path):
    fixture = json.loads(path.read_text(encoding="utf-8"))
    if fixture["expected_valid"]:
        validate(fixture["schema"], fixture["data"])
    else:
        with pytest.raises(ValidationError):
            validate(fixture["schema"], fixture["data"])


def test_implemented_contract_subset():
    spec = app.openapi()
    operations = set()
    for path, methods in spec["paths"].items():
        for method, definition in methods.items():
            assert definition == OPENAPI["paths"][path][method]
            operations.add(definition["operationId"])
    assert operations == IMPLEMENTED
    assert spec["components"] == OPENAPI["components"]
    assert len(operations) == sum(len(m) for m in OPENAPI["paths"].values())


@pytest.mark.parametrize(
    "path",
    [
        "https://evil.test",
        "//evil.test",
        "/\\evil.test",
        "/%5cevil.test",
        "/%252f%252fevil.test",
        "/\r\nevil",
        "/auth/login",
    ],
)
def test_redirect_rejects_external_and_controls(path):
    assert safe_return_to(path) == "/"


def test_redirect_preserves_deep_link():
    path = "/map?city=abc&revision=xyz&zoom=13"
    assert safe_return_to(path) == path
