from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional


def _bool_env(name: str, default: bool) -> bool:
    raw = _str_env(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def _int_env(name: str, default: int) -> int:
    raw = _str_env(name)
    if raw is None or raw.strip() == "":
        return default
    return int(raw)

def _str_env(name: str, default: str = "") -> str:
    raw = os.getenv(name)
    if raw is None:
        return default

    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        value = value[1:-1]

    return value

@dataclass(frozen=True)
class KeyBinding:
    name: str
    value: str
    source_domain: Optional[str]
    can_ingest: bool
    can_status: bool
    can_dispatch: bool


@dataclass(frozen=True)
class AppConfig:
    collection_enabled: bool
    mixpanel_export_enabled: bool
    allow_unknown_events: bool
    distinct_id_salt: str
    sql_connection_string: str

    mixpanel_project_id: str
    mixpanel_api_base_url: str
    mixpanel_service_account_username: str
    mixpanel_service_account_password: str
    mixpanel_strict: bool
    mixpanel_batch_size: int
    mixpanel_max_attempts: int

    key_bindings: tuple[KeyBinding, ...]

    @staticmethod
    def from_env() -> "AppConfig":
        bindings = (
            KeyBinding(
                name="core",
                value=_str_env("ANALYTICS_FUNCTION_KEY_CORE", ""),
                source_domain="core",
                can_ingest=True,
                can_status=False,
                can_dispatch=False,
            ),
            KeyBinding(
                name="jobs",
                value=_str_env("ANALYTICS_FUNCTION_KEY_JOBS", ""),
                source_domain="jobs",
                can_ingest=True,
                can_status=False,
                can_dispatch=False,
            ),
            KeyBinding(
                name="users",
                value=_str_env("ANALYTICS_FUNCTION_KEY_USERS", ""),
                source_domain="users",
                can_ingest=True,
                can_status=False,
                can_dispatch=False,
            ),
            KeyBinding(
                name="enrichers",
                value=_str_env("ANALYTICS_FUNCTION_KEY_ENRICHERS", ""),
                source_domain="enrichers",
                can_ingest=True,
                can_status=False,
                can_dispatch=False,
            ),
            KeyBinding(
                name="scheduler",
                value=_str_env("ANALYTICS_FUNCTION_KEY_SCHEDULER", ""),
                source_domain=None,
                can_ingest=False,
                can_status=True,
                can_dispatch=True,
            ),
            KeyBinding(
                name="operator",
                value=_str_env("ANALYTICS_FUNCTION_KEY_OPERATOR", ""),
                source_domain=None,
                can_ingest=False,
                can_status=True,
                can_dispatch=False,
            ),
        )

        return AppConfig(
            collection_enabled=_bool_env("ANALYTICS_COLLECTION_ENABLED", True),
            mixpanel_export_enabled=_bool_env("ANALYTICS_MIXPANEL_EXPORT_ENABLED", False),
            allow_unknown_events=_bool_env("ANALYTICS_ALLOW_UNKNOWN_EVENTS", False),
            distinct_id_salt=_str_env("ANALYTICS_DISTINCT_ID_SALT", ""),
            sql_connection_string=_str_env("ANALYTICS_SQL_CONNECTION_STRING", ""),
            mixpanel_project_id=_str_env("MIXPANEL_PROJECT_ID", ""),
            mixpanel_api_base_url=_str_env("MIXPANEL_API_BASE_URL", "https://api-eu.mixpanel.com"),
            mixpanel_service_account_username=_str_env("MIXPANEL_SERVICE_ACCOUNT_USERNAME", ""),
            mixpanel_service_account_password=_str_env("MIXPANEL_SERVICE_ACCOUNT_PASSWORD", ""),
            mixpanel_strict=_bool_env("MIXPANEL_STRICT", True),
            mixpanel_batch_size=_int_env("MIXPANEL_BATCH_SIZE", 500),
            mixpanel_max_attempts=_int_env("MIXPANEL_MAX_ATTEMPTS", 8),
            key_bindings=bindings,
        )

    def validate_startup(self) -> None:
        missing = []

        if not self.sql_connection_string:
            missing.append("ANALYTICS_SQL_CONNECTION_STRING")
        if not self.distinct_id_salt:
            missing.append("ANALYTICS_DISTINCT_ID_SALT")

        enabled_bindings = [b for b in self.key_bindings if b.value]
        if not enabled_bindings:
            missing.append("at least one ANALYTICS_FUNCTION_KEY_*")

        if missing:
            raise RuntimeError("Missing required Analytics configuration: " + ", ".join(missing))
