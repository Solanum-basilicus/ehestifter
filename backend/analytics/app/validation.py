from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Any

from app.auth import AuthContext
from app.config import AppConfig


V1_EVENT_NAMES = {
    "Job Creation Started",
    "Job Duplicate Checked",
    "Job List Viewed",
    "Job Detail Viewed",
    "Job Search Performed",
    "Job Created",
    "Job Creation Failed",
    "Job Updated",
    "Job Deleted",
    "Job Status Changed",
    "CV Updated",
    "Compatibility Requested",
    "Compatibility Completed",
    "Compatibility Failed",
}

ALLOWED_SOURCE_DOMAINS = {"core", "jobs", "users", "enrichers"}
ALLOWED_SOURCE_SURFACES = {"web", "worker", "timer", "system"}

FORBIDDEN_PROPERTY_KEYS = {
    "email",
    "display_name",
    "name",
    "telegram_account_id",
    "telegram_username",
    "cv_text",
    "cv_plaintext",
    "cv_delta",
    "cv_length",
    "job_title",
    "job_name",
    "company_name",
    "job_description",
    "description",
    "summary",
    "raw_url",
    "url",
    "external_id",
    "provider_external_id",
    "link_code",
    "function_key",
    "access_token",
    "token",
    "password",
    "cookie",
    "exception",
    "stack_trace",
}

_MAX_STRING_VALUE_LENGTH = 1000


class ValidationError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def validate_event_payload(payload: Any, auth: AuthContext, config: AppConfig) -> dict[str, Any]:
    if not config.collection_enabled:
        raise ValidationError("collection_disabled", "Analytics collection is disabled.")

    if not isinstance(payload, dict):
        raise ValidationError("invalid_json", "Request body must be a JSON object.")

    if not auth.can_ingest:
        raise ValidationError("forbidden_key", "Presented key is not allowed to ingest events.")

    event_name = _required_str(payload, "eventName", max_len=80)
    if event_name not in V1_EVENT_NAMES and not config.allow_unknown_events:
        raise ValidationError("unknown_event_name", f"Event name is not allowlisted: {event_name}")

    source_domain = _required_str(payload, "sourceDomain", max_len=40)
    if source_domain not in ALLOWED_SOURCE_DOMAINS:
        raise ValidationError("invalid_source_domain", "sourceDomain is not supported.")

    if auth.source_domain != source_domain:
        raise ValidationError("source_domain_key_mismatch", "Presented key cannot emit this sourceDomain.")

    source_surface = _required_str(payload, "sourceSurface", max_len=40)
    if source_surface not in ALLOWED_SOURCE_SURFACES:
        raise ValidationError("invalid_source_surface", "sourceSurface is not supported in v1.")

    schema_version = payload.get("schemaVersion")
    if schema_version != 1:
        raise ValidationError("invalid_schema_version", "schemaVersion must be 1.")

    occurred_at_utc = _parse_required_utc(payload.get("occurredAtUtc"), "occurredAtUtc")

    user_id = _optional_uuid_str(payload.get("userId"), "userId")
    subject_type = _optional_str(payload.get("subjectType"), "subjectType", max_len=40)
    subject_id = _optional_str(payload.get("subjectId"), "subjectId", max_len=80)
    correlation_id = _optional_str(payload.get("correlationId"), "correlationId", max_len=100)
    producer_event_id = _optional_str(payload.get("producerEventId"), "producerEventId", max_len=120)

    properties = payload.get("properties", {})
    if properties is None:
        properties = {}
    if not isinstance(properties, dict):
        raise ValidationError("invalid_properties", "properties must be a JSON object.")

    _validate_safe_properties(properties)

    return {
        "eventName": event_name,
        "occurredAtUtc": occurred_at_utc,
        "sourceDomain": source_domain,
        "sourceSurface": source_surface,
        "userId": user_id,
        "subjectType": subject_type,
        "subjectId": subject_id,
        "correlationId": correlation_id,
        "properties": properties,
        "schemaVersion": schema_version,
        "producerEventId": producer_event_id,
    }


def _required_str(payload: dict[str, Any], key: str, max_len: int) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"missing_{_snake(key)}", f"{key} is required.")
    value = value.strip()
    if len(value) > max_len:
        raise ValidationError(f"{_snake(key)}_too_long", f"{key} is too long.")
    return value


def _optional_str(value: Any, key: str, max_len: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValidationError(f"invalid_{_snake(key)}", f"{key} must be a string or null.")
    value = value.strip()
    if value == "":
        return None
    if len(value) > max_len:
        raise ValidationError(f"{_snake(key)}_too_long", f"{key} is too long.")
    return value


def _optional_uuid_str(value: Any, key: str) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise ValidationError(f"invalid_{_snake(key)}", f"{key} must be a UUID string or null.")
    try:
        return str(uuid.UUID(value))
    except ValueError as exc:
        raise ValidationError(f"invalid_{_snake(key)}", f"{key} must be a valid UUID.") from exc


def _parse_required_utc(value: Any, key: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"missing_{_snake(key)}", f"{key} is required.")

    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"

    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError as exc:
        raise ValidationError(f"invalid_{_snake(key)}", f"{key} must be an ISO-8601 timestamp.") from exc

    if parsed.tzinfo is None:
        raise ValidationError(f"invalid_{_snake(key)}", f"{key} must include UTC timezone information.")

    return parsed.astimezone(timezone.utc).replace(tzinfo=None)


def _validate_safe_properties(value: Any, path: str = "properties") -> None:
    if isinstance(value, dict):
        for key, nested in value.items():
            if not isinstance(key, str):
                raise ValidationError("invalid_property_key", f"{path} contains a non-string key.")
            normalized = _normalize_property_key(key)
            if normalized in FORBIDDEN_PROPERTY_KEYS:
                raise ValidationError("forbidden_property", f"Forbidden analytics property key: {path}.{key}")
            _validate_safe_properties(nested, f"{path}.{key}")
        return

    if isinstance(value, list):
        for index, nested in enumerate(value):
            _validate_safe_properties(nested, f"{path}[{index}]")
        return

    if isinstance(value, str) and len(value) > _MAX_STRING_VALUE_LENGTH:
        raise ValidationError("property_value_too_long", f"{path} string value is too long.")

    if value is None or isinstance(value, (str, int, float, bool)):
        return

    raise ValidationError("invalid_property_value", f"{path} contains an unsupported JSON value.")


def _normalize_property_key(key: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", key.strip().lower()).strip("_")


def _snake(key: str) -> str:
    return _normalize_property_key(key)


