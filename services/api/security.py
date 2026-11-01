import hashlib
import secrets
from datetime import UTC, datetime

from sqlalchemy import select

from packages.domain.errors import DomainError
from services.api.config import settings
from services.api.models import CityGrant, DatasetGrant, Principal, WebSession

LEVEL = {"viewer": 0, "specialist": 1, "admin": 2}


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


class Access:
    def __init__(self, db, principal, web_session):
        self.db, self.user, self.session = db, principal, web_session
        self.cities = set(
            db.scalars(select(CityGrant.city_id).where(CityGrant.user_id == principal.id))
        )
        self.datasets = set(
            db.scalars(select(DatasetGrant.dataset_id).where(DatasetGrant.user_id == principal.id))
        )
        self.level = max((LEVEL.get(r, -1) for r in principal.roles), default=-1)

    def role(self, name):
        if self.level < LEVEL[name]:
            raise DomainError(403, "role_required", "Insufficient role")

    def city(self, city_id):
        if city_id not in self.cities:
            raise DomainError(404, "not_found", "Object not found")

    def dataset(self, dataset):
        self.city(dataset.city_id)
        if dataset.access_level == "restricted" and dataset.id not in self.datasets:
            raise DomainError(404, "not_found", "Object not found")
        if dataset.access_level == "internal":
            self.role("specialist")

    def mutation(self, request):
        if request.headers.get("origin") != settings().public_origin:
            raise DomainError(403, "origin_rejected", "Request origin is not allowed")
        token = request.headers.get("x-csrf-token", "")
        if not secrets.compare_digest(token, self.session.csrf_token):
            raise DomainError(403, "csrf_rejected", "CSRF token is missing or invalid")


def authenticate(db, request):
    token = request.cookies.get("pavlodar_session", "")
    web_session = db.get(WebSession, digest(token)) if token else None
    if not web_session or web_session.expires_at <= datetime.now(UTC):
        raise DomainError(401, "authentication_required", "Sign in to continue")
    principal = db.get(Principal, web_session.user_id)
    if not principal or not principal.active:
        raise DomainError(401, "session_revoked", "Session is no longer authorized")
    return Access(db, principal, web_session)
