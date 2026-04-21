from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    app_id: str
    app_key: str
    base_url: str = "https://api.adzuna.com/v1/api"
    timeout_seconds: float = 30.0


class ConfigurationError(ValueError):
    pass



def load_settings() -> Settings:
    app_id = os.getenv("ADZUNA_APP_ID", "").strip()
    app_key = os.getenv("ADZUNA_APP_KEY", "").strip()
    base_url = os.getenv("ADZUNA_BASE_URL", "https://api.adzuna.com/v1/api").strip()
    timeout_raw = os.getenv("ADZUNA_TIMEOUT_SECONDS", "30").strip()

    if not app_id:
        raise ConfigurationError("Missing required environment variable ADZUNA_APP_ID")
    if not app_key:
        raise ConfigurationError("Missing required environment variable ADZUNA_APP_KEY")

    try:
        timeout_seconds = float(timeout_raw)
    except ValueError as exc:
        raise ConfigurationError(
            f"Invalid ADZUNA_TIMEOUT_SECONDS value: {timeout_raw!r}"
        ) from exc

    return Settings(
        app_id=app_id,
        app_key=app_key,
        base_url=base_url.rstrip("/"),
        timeout_seconds=timeout_seconds,
    )
