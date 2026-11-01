"""Real local Keycloak authorization-code flow and persisted API smoke, no auth bypass.

--read-only stops after sign-in, /v1/me and cities and signs out again: it writes no
SYNTHETIC rows, for a shared stand that must stay clean.
"""

import argparse
import html
import json
import os
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

import httpx

from packages.domain.contracts import validate
from services.api.config import settings
from tests.test_foundation import revision_body, zone_body

ROOT = Path(__file__).resolve().parents[2]


class LoginForm(HTMLParser):
    def __init__(self):
        super().__init__()
        self.action = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "form" and attrs.get("id") == "kc-form-login":
            self.action = html.unescape(attrs["action"])


def login(client, role="specialist"):
    config = settings()
    start = client.get("/auth/login", params={"return_to": "/map?foundation=verified"})
    assert start.status_code == 302, start.text
    with httpx.Client(timeout=20, follow_redirects=False) as provider:
        screen = provider.get(start.headers["location"])
        form = LoginForm()
        form.feed(screen.text)
        assert form.action, "Provider login form unavailable"
        # Browsers allow Secure cookies on trustworthy localhost HTTP. httpx's
        # CookieJar does not. Emulate that localhost-only behavior in this harness;
        # never change cookies from remote providers or application configuration.
        assert urlsplit(form.action).hostname == "localhost"
        for cookie in provider.cookies.jar:
            if cookie.domain in {"localhost", "localhost.local"}:
                cookie.secure = False
        path = os.environ.get("PG_TEST_CREDENTIALS") or ROOT / ".local/test-credentials.json"
        credentials = json.loads(Path(path).read_text())
        authenticated = provider.post(
            form.action, data={"username": role, "password": credentials[role], "credentialId": ""}
        )
        assert authenticated.status_code == 302, "OIDC sign-in did not redirect"
        location = urlsplit(authenticated.headers["location"])
        assert location.netloc == urlsplit(config.public_origin).netloc
        callback_path = location.path + "?" + location.query
        callback = client.get(callback_path)
    assert callback.status_code == 302, callback.text
    assert callback.headers["location"] == "/map?foundation=verified"
    assert "httponly" in callback.headers["set-cookie"].lower()
    assert client.get(callback_path).status_code == 401, "OIDC state replay was accepted"
    me = client.get("/v1/me")
    assert me.status_code == 200, me.text
    validate("User", me.json())
    client.headers.update({"Origin": config.public_origin, "X-CSRF-Token": me.json()["csrf_token"]})
    return me.json()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://localhost:8001")
    parser.add_argument("--write-fixtures", action="store_true")
    parser.add_argument("--read-only", action="store_true")
    args = parser.parse_args()
    assert settings().environment in {"development", "test"}
    captures = {}
    with httpx.Client(base_url=args.base_url, timeout=20, follow_redirects=False) as client:
        assert client.get("/v1/me").status_code == 401
        me = login(client)
        cities = client.get("/v1/cities").json()
        validate("CityPage", cities)
        captures["foundation_cities"] = ("CityPage", cities)
        if args.read_only:
            assert not args.write_fixtures, "--read-only captures no fixtures"
            assert (
                client.post("/auth/logout", headers={"Idempotency-Key": str(uuid4())}).status_code
                == 204
            )
            assert client.get("/v1/me").status_code == 401
            print(
                json.dumps(
                    {
                        "scope": "Real Keycloak authorization code + PKCE against the API, read-only",
                        "passed": True,
                        "oidc_pkce_state_replay_checked": True,
                        "roles": me["roles"],
                        "cities": len(cities["items"]),
                        "writes": 0,
                    }
                )
            )
            return
        dataset = client.post(
            "/v1/datasets",
            headers={"Idempotency-Key": str(uuid4())},
            json={
                "city_id": me["city_ids"][0],
                "name": "SYNTHETIC TEST source registry",
                "kind": "zones",
                "owner": "Synthetic integration test",
                "license": "CC0-1.0",
                "access_level": "public",
                "source_uri": None,
            },
        )
        assert dataset.status_code == 201, dataset.text
        captures["foundation_dataset"] = ("Dataset", dataset.json())
        created = client.post(
            "/v1/zones", json=zone_body(), headers={"Idempotency-Key": str(uuid4())}
        )
        assert created.status_code == 201, created.text
        zone = created.json()
        captures["foundation_zone"] = ("Zone", zone)
        body = {
            "city_id": zone["city_id"],
            "zone_id": zone["id"],
            "name": "SYNTHETIC OIDC integration",
            "base_revision_id": None,
            "initial_state": revision_body(zone),
        }
        headers = {"Idempotency-Key": str(uuid4())}
        saved = client.post("/v1/scenarios", json=body, headers=headers)
        assert saved.status_code == 201, saved.text
        assert client.post("/v1/scenarios", json=body, headers=headers).json() == saved.json()
        revision = client.get(f"/v1/scenario-revisions/{saved.json()['current_revision_id']}")
        assert revision.status_code == 200, revision.text
        captures["foundation_revision"] = ("ScenarioRevision", revision.json())
        captures["foundation_scenario"] = ("Scenario", saved.json())
        result = {
            "scope": "Real HTTP API + Keycloak + PostGIS, explicitly synthetic inputs",
            "passed": True,
            "oidc_pkce_state_replay_checked": True,
            "scenario_id": saved.json()["id"],
            "revision_id": revision.json()["id"],
            "organizer_data_received": False,
        }
        assert (
            client.post("/auth/logout", headers={"Idempotency-Key": str(uuid4())}).status_code
            == 204
        )
        assert client.get("/v1/me").status_code == 401
    if args.write_fixtures:
        for name, (schema, data) in captures.items():
            validate(schema, data)
            target = ROOT / "contracts/fixtures" / (name + ".json")
            target.write_text(
                json.dumps(
                    {
                        "fixture_only": True,
                        "schema": schema,
                        "expected_valid": True,
                        "origin": "Captured from running API with explicit synthetic test profile; not organizer data",
                        "data": data,
                    },
                    indent=2,
                    ensure_ascii=False,
                )
                + "\n",
                encoding="utf-8",
            )
    (ROOT / "docs/evidence/foundation_oidc.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
