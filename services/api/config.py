import re
from functools import lru_cache

from pydantic import SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="PAVLODAR_",
        env_file=(".env", ".env.llm.local"),
        extra="ignore",
    )
    database_url: SecretStr
    redis_url: str = "redis://localhost:6381/0"
    environment: str = "production"
    public_origin: str = "https://localhost"
    oidc_issuer: str = ""
    oidc_internal_origin: str = ""
    oidc_client_id: str = "pavlodar-web"
    oidc_client_secret: SecretStr = SecretStr("")
    token_encryption_key: SecretStr
    cookie_secure: bool = True
    session_seconds: int = 28800
    release: str = "foundation-development"
    upload_root: str = ".local/uploads"
    tile_root: str = ".local/tiles"
    export_root: str = ".local/exports"
    export_max_bytes: int = 20_000_000
    llm_provider: str = "disabled"
    llm_model: str = ""
    llm_fallback_providers: str = ""
    llm_timeout_seconds: float = 20.0
    llm_max_output_tokens: int = 800
    gemini_model: str = "gemini-3.5-flash-lite"
    gemini_api_key: SecretStr = SecretStr("")
    groq_model: str = "openai/gpt-oss-20b"
    groq_api_key: SecretStr = SecretStr("")
    openrouter_api_key: SecretStr = SecretStr("")
    # Development/test only: an OpenAI-compatible endpoint on loopback (tools/dev/llm_stub.py).
    llm_local_base_url: str = ""

    @model_validator(mode="after")
    def secure_defaults(self):
        if self.environment not in {"production", "development", "test"}:
            raise ValueError("Invalid environment")
        if not 1 <= self.export_max_bytes <= 20_000_000:
            raise ValueError("Export size limit must stay within the database artifact bound")
        providers = [self.llm_provider, *self.llm_fallback_provider_names]
        if any(
            provider not in {"disabled", "gemini", "groq", "openrouter", "local"}
            for provider in providers
        ):
            raise ValueError("Invalid LLM provider")
        if "local" in providers and (
            self.environment == "production"
            or not re.fullmatch(
                r"http://(127\.0\.0\.1|localhost):[0-9]{2,5}(/[A-Za-z0-9/_-]*)?",
                self.llm_local_base_url,
            )
        ):
            raise ValueError("Local LLM endpoint is development-only and loopback-only")
        if len(set(providers)) != len(providers):
            raise ValueError("LLM providers must be unique")
        if self.llm_provider == "disabled" and self.llm_fallback_provider_names:
            raise ValueError("Disabled LLM cannot have fallback providers")
        if "openrouter" in providers and not re.fullmatch(r"[A-Za-z0-9._:/-]{1,200}", self.llm_model):
            raise ValueError("Invalid OpenRouter model")
        if "gemini" in providers and not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", self.gemini_model):
            raise ValueError("Invalid Gemini model")
        if "groq" in providers and not re.fullmatch(r"[A-Za-z0-9._/-]{1,100}", self.groq_model):
            raise ValueError("Invalid Groq model")
        if not 1 <= self.llm_timeout_seconds <= 60:
            raise ValueError("LLM timeout must be between 1 and 60 seconds")
        if not 64 <= self.llm_max_output_tokens <= 2048:
            raise ValueError("LLM output token limit must be between 64 and 2048")
        if self.environment == "production":
            if self.oidc_internal_origin:
                raise ValueError("Local OIDC backchannel mapping is development-only")
            if not self.cookie_secure or not self.public_origin.startswith("https://"):
                raise ValueError("Production requires HTTPS and Secure cookies")
            if not self.oidc_issuer.startswith("https://"):
                raise ValueError("Production requires an HTTPS OIDC issuer")
        from cryptography.fernet import Fernet

        Fernet(self.token_encryption_key.get_secret_value().encode())
        return self

    @property
    def llm_fallback_provider_names(self):
        return tuple(
            item.strip()
            for item in self.llm_fallback_providers.split(",")
            if item.strip()
        )


@lru_cache
def settings():
    return Settings()
