"""Create local secrets and an explicit synthetic test identity realm; never overwrite."""

import json
import secrets
from pathlib import Path

from cryptography.fernet import Fernet

ROOT = Path(__file__).resolve().parents[2]


def main():
    env = ROOT / ".env"
    if env.exists():
        raise SystemExit(".env already exists; refusing to replace credentials")
    password, client_secret = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    values = (
        (ROOT / ".env.example")
        .read_text()
        .replace("PAVLODAR_DB_PASSWORD=\n", f"PAVLODAR_DB_PASSWORD={password}\n")
        .replace(
            "PAVLODAR_DATABASE_URL=\n",
            f"PAVLODAR_DATABASE_URL=postgresql+psycopg://pavlodar:{password}@127.0.0.1:5433/pavlodar\n",
        )
        .replace(
            "PAVLODAR_TOKEN_ENCRYPTION_KEY=\n",
            "PAVLODAR_TOKEN_ENCRYPTION_KEY=" + Fernet.generate_key().decode() + "\n",
        )
        .replace("PAVLODAR_OIDC_CLIENT_SECRET=\n", f"PAVLODAR_OIDC_CLIENT_SECRET={client_secret}\n")
    )
    env.write_text(values, encoding="utf-8")
    users, credentials = [], {}
    for index, role in enumerate(["admin", "specialist", "viewer"], start=1):
        credential = secrets.token_urlsafe(18)
        credentials[role] = credential
        users.append(
            {
                "id": f"00000000-0000-4000-8000-{index:012}",
                "username": role,
                "enabled": True,
                "emailVerified": True,
                "firstName": "Synthetic",
                "lastName": role,
                "email": f"{role}@example.invalid",
                "credentials": [{"type": "password", "value": credential, "temporary": False}],
            }
        )
    realm = {
        "realm": "pavlodar-test",
        "enabled": True,
        "registrationAllowed": False,
        "sslRequired": "none",
        "bruteForceProtected": True,
        "clients": [
            {
                "clientId": "pavlodar-web",
                "secret": client_secret,
                "publicClient": False,
                "standardFlowEnabled": True,
                "directAccessGrantsEnabled": False,
                "redirectUris": [
                    "http://localhost:5173/auth/callback",
                    "http://localhost:8001/auth/callback",
                ],
                "attributes": {"pkce.code.challenge.method": "S256"},
            }
        ],
        "users": users,
    }
    (ROOT / "infra/keycloak-test-realm.json").write_text(json.dumps(realm), encoding="utf-8")
    local = ROOT / ".local"
    local.mkdir(exist_ok=True)
    (local / "test-credentials.json").write_text(json.dumps(credentials), encoding="utf-8")
    print(
        "Created ignored .env, test realm and .local/test-credentials.json. No credentials printed."
    )


if __name__ == "__main__":
    main()
