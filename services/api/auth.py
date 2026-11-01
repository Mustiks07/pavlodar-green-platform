import json
import secrets
from datetime import UTC, datetime, timedelta
from urllib.parse import unquote, urlsplit

import httpx
from authlib.integrations.httpx_client import AsyncOAuth2Client
from authlib.jose import JsonWebToken
from cryptography.fernet import Fernet
from fastapi.responses import RedirectResponse
from sqlalchemy import delete, select

from packages.domain.errors import DomainError
from services.api.config import settings
from services.api.db import session
from services.api.models import LoginState, Principal, WebSession
from services.api.security import digest


def safe_return_to(value):
    if not value or len(value) > 2048:
        return "/"
    decoded = value
    for _ in range(4):
        decoded = unquote(decoded)
    if not decoded.startswith("/") or decoded.startswith("//") or "\\" in decoded:
        return "/"
    if any(ord(c) < 32 or ord(c) == 127 for c in decoded):
        return "/"
    parsed = urlsplit(decoded)
    if parsed.scheme or parsed.netloc or parsed.path.startswith("/auth"):
        return "/"
    return value


async def provider_metadata():
    config = settings()
    if not config.oidc_issuer:
        raise DomainError(503, "oidc_not_configured", "Identity provider is not configured")
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            response = await client.get(
                backchannel(config.oidc_issuer + "/.well-known/openid-configuration")
            )
            response.raise_for_status()
            metadata = response.json()
        if metadata["issuer"] != config.oidc_issuer:
            raise ValueError("issuer mismatch")
        # Discovery is trusted configuration, never a caller supplied URL.
        for key in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
            endpoint = urlsplit(metadata[key])
            if endpoint.scheme not in {"https", "http"}:
                raise ValueError("invalid endpoint")
            if config.environment == "production" and endpoint.scheme != "https":
                raise ValueError("insecure endpoint")
        return metadata
    except (httpx.HTTPError, ValueError, KeyError):
        raise DomainError(503, "oidc_unavailable", "Identity provider is unavailable") from None


def backchannel(url):
    config = settings()
    if config.oidc_internal_origin:
        issuer = urlsplit(config.oidc_issuer)
        target = urlsplit(url)
        if (target.scheme, target.netloc) != (issuer.scheme, issuer.netloc):
            raise DomainError(503, "oidc_endpoint_invalid", "Provider endpoint origin mismatch")
        return config.oidc_internal_origin.rstrip("/") + target.path
    return url


def oauth_client():
    config = settings()
    return AsyncOAuth2Client(
        config.oidc_client_id,
        config.oidc_client_secret.get_secret_value(),
        scope="openid profile",
        redirect_uri=config.public_origin + "/auth/callback",
        code_challenge_method="S256",
        timeout=10,
    )


async def login(request):
    metadata = await provider_metadata()
    state, nonce, verifier, browser = (secrets.token_urlsafe(32) for _ in range(4))
    async with oauth_client() as client:
        location, _ = client.create_authorization_url(
            metadata["authorization_endpoint"], state=state, nonce=nonce, code_verifier=verifier
        )
    with session() as db, db.begin():
        db.execute(delete(LoginState).where(LoginState.expires_at < datetime.now(UTC)))
        db.add(
            LoginState(
                state_hash=digest(state),
                browser_hash=digest(browser),
                nonce=nonce,
                verifier=verifier,
                return_to=safe_return_to(request.query_params.get("return_to")),
                expires_at=datetime.now(UTC) + timedelta(minutes=5),
            )
        )
    response = RedirectResponse(location, status_code=302)
    response.set_cookie(
        "pavlodar_login",
        browser,
        max_age=300,
        httponly=True,
        secure=settings().cookie_secure,
        samesite="lax",
        path="/auth",
    )
    return response


async def callback(request):
    state = request.query_params.get("state", "")
    code = request.query_params.get("code", "")
    if not state or not code:
        raise DomainError(422, "oidc_callback_invalid", "Missing authorization response")
    with session() as db, db.begin():
        pending = db.scalar(
            select(LoginState).where(LoginState.state_hash == digest(state)).with_for_update()
        )
        if (
            not pending
            or pending.expires_at <= datetime.now(UTC)
            or not secrets.compare_digest(
                pending.browser_hash, digest(request.cookies.get("pavlodar_login", ""))
            )
        ):
            raise DomainError(
                401, "oidc_state_invalid", "Login expired or does not match this browser"
            )
        nonce, verifier, destination = pending.nonce, pending.verifier, pending.return_to
        db.delete(pending)  # One use even if token exchange subsequently fails.
    metadata = await provider_metadata()
    config = settings()
    try:
        async with oauth_client() as client:
            tokens = await client.fetch_token(
                backchannel(metadata["token_endpoint"]), code=code, code_verifier=verifier
            )
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            response = await client.get(backchannel(metadata["jwks_uri"]))
            response.raise_for_status()
            keys = response.json()
        claims = JsonWebToken(["RS256", "ES256"]).decode(
            tokens["id_token"],
            keys,
            claims_options={
                "iss": {"essential": True, "value": config.oidc_issuer},
                "aud": {"essential": True, "value": config.oidc_client_id},
                "exp": {"essential": True},
                "iat": {"essential": True},
                "sub": {"essential": True},
                "nonce": {"essential": True, "value": nonce},
            },
        )
        claims.validate(leeway=30)
        if (
            isinstance(claims["aud"], list)
            and len(claims["aud"]) > 1
            and claims.get("azp") != config.oidc_client_id
        ):
            raise ValueError("authorized party mismatch")
    except Exception:  # noqa: BLE001 - trust boundary: never expose secret-bearing exceptions
        # Provider exceptions can include token responses; never expose them or log repr.
        raise DomainError(
            401, "oidc_token_invalid", "Identity response could not be validated"
        ) from None
    with session() as db, db.begin():
        user = db.scalar(
            select(Principal).where(
                Principal.issuer == config.oidc_issuer,
                Principal.subject == claims["sub"],
                Principal.active.is_(True),
            )
        )
        if not user or not user.roles:
            raise DomainError(
                403, "account_not_provisioned", "An administrator must grant platform access"
            )
        old = request.cookies.get("pavlodar_session")
        if old:
            db.execute(delete(WebSession).where(WebSession.token_hash == digest(old)))
        token = secrets.token_urlsafe(48)
        db.add(
            WebSession(
                token_hash=digest(token),
                user_id=user.id,
                csrf_token=secrets.token_urlsafe(32),
                expires_at=datetime.now(UTC) + timedelta(seconds=config.session_seconds),
                encrypted_provider_tokens=Fernet(
                    config.token_encryption_key.get_secret_value().encode()
                )
                .encrypt(json.dumps(tokens).encode())
                .decode(),
            )
        )
    response = RedirectResponse(destination, status_code=302)
    response.set_cookie(
        "pavlodar_session",
        token,
        max_age=config.session_seconds,
        secure=config.cookie_secure,
        httponly=True,
        samesite="lax",
        path="/",
    )
    response.delete_cookie("pavlodar_login", path="/auth")
    return response
