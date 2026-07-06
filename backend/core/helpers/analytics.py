from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Mapping

import requests
from flask import session


logger = logging.getLogger(__name__)

_JOB_CREATE_FLOW_SESSION_KEY = "analytics_job_create_flow_id"


def analytics_collection_enabled() -> bool:
    return os.getenv("ANALYTICS_COLLECTION_ENABLED", "0").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def ensure_job_create_flow_id() -> str:
    """
    Best-effort per-session correlation id for the web job-create flow.

    This is intentionally stored only in Flask session state. It is a UX-flow
    breadcrumb, not domain state.
    """
    try:
        existing = session.get(_JOB_CREATE_FLOW_SESSION_KEY)
        if isinstance(existing, str) and existing.strip():
            return existing

        created = str(uuid.uuid4())
        session[_JOB_CREATE_FLOW_SESSION_KEY] = created
        return created

    except RuntimeError:
        # Outside request context. Keep helper safe for tests/import-time usage.
        return str(uuid.uuid4())


def get_user_id_for_analytics(context: dict | None, *, resolve_if_missing: bool = True) -> str | None:
    """
    Resolve canonical in-app user id for Analytics.

    Cache-first to avoid unnecessary Users calls on simple page renders.
    Falls back to helpers.users.get_in_app_user_id only when needed.
    """
    try:
        cached = session.get("in_app_user_cache")
        if isinstance(cached, dict):
            data = cached.get("data")
            if isinstance(data, dict):
                cached_user_id = _clean_user_id(data.get("userId"))
                if cached_user_id:
                    return cached_user_id
    except RuntimeError:
        pass

    if not resolve_if_missing:
        return None

    try:
        from helpers.users import get_in_app_user_id

        return _clean_user_id(get_in_app_user_id(context or {}))

    except Exception as exc:
        logger.warning(
            "analytics_user_id_resolution_failed error_type=%s",
            type(exc).__name__,
        )
        return None


def emit_core_event(
    event_name: str,
    *,
    user_id: str | None,
    subject_type: str | None = None,
    subject_id: str | None = None,
    correlation_id: str | None = None,
    properties: Mapping[str, Any] | None = None,
    producer_event_id: str | None = None,
    require_user_id: bool = True,
) -> bool:
    """
    Emit one Web Core analytics event.

    Design rules:
    - server-side only;
    - short timeout;
    - no exception escapes to product routes;
    - never logs function keys or full payloads;
    - skips user-attributable web events when canonical user id is unavailable,
      because Analytics can store userId=null but Mixpanel export cannot build
      a distinct_id for those rows.
    """
    if not analytics_collection_enabled():
        return False

    base_url = os.getenv("ANALYTICS_BASE_URL", "").rstrip("/")
    function_key = os.getenv("ANALYTICS_FUNCTION_KEY", "")

    if not base_url or not function_key:
        logger.warning(
            "analytics_not_configured event=%s base_configured=%s key_configured=%s",
            event_name,
            bool(base_url),
            bool(function_key),
        )
        return False

    cleaned_user_id = _clean_user_id(user_id)
    if require_user_id and not cleaned_user_id:
        logger.warning(
            "analytics_event_skipped_missing_user_id event=%s subject_type=%s subject_id=%s",
            event_name,
            subject_type,
            subject_id,
        )
        return False

    payload = {
        "eventName": event_name,
        "occurredAtUtc": _utc_now_iso(),
        "sourceDomain": "core",
        "sourceSurface": "web",
        "userId": cleaned_user_id,
        "subjectType": subject_type,
        "subjectId": _optional_str(subject_id),
        "correlationId": _optional_str(correlation_id),
        "properties": _drop_none_values(dict(properties or {})),
        "schemaVersion": 1,
        "producerEventId": _optional_str(producer_event_id),
    }

    timeout = _analytics_timeout_seconds()

    try:
        response = requests.post(
            f"{base_url}/analytics/events",
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "x-functions-key": function_key,
            },
            json=payload,
            timeout=timeout,
        )

        if response.status_code >= 400:
            error_code = None
            try:
                error_body = response.json()
                if isinstance(error_body, dict):
                    error_code = error_body.get("error")
            except Exception:
                pass

            logger.warning(
                "analytics_emit_failed event=%s status=%s error=%s subject_type=%s subject_id=%s",
                event_name,
                response.status_code,
                error_code,
                subject_type,
                subject_id,
            )
            return False

        return True

    except requests.Timeout:
        logger.warning(
            "analytics_emit_timeout event=%s timeout_seconds=%s subject_type=%s subject_id=%s",
            event_name,
            timeout,
            subject_type,
            subject_id,
        )
        return False

    except requests.RequestException as exc:
        logger.warning(
            "analytics_emit_request_failed event=%s error_type=%s subject_type=%s subject_id=%s",
            event_name,
            type(exc).__name__,
            subject_type,
            subject_id,
        )
        return False

    except Exception as exc:
        logger.warning(
            "analytics_emit_unexpected_failed event=%s error_type=%s subject_type=%s subject_id=%s",
            event_name,
            type(exc).__name__,
            subject_type,
            subject_id,
        )
        return False


def _analytics_timeout_seconds() -> float:
    raw = os.getenv("ANALYTICS_EMIT_TIMEOUT_SECONDS", "2").strip()
    try:
        value = float(raw)
    except ValueError:
        return 2.0

    if value <= 0:
        return 2.0

    return min(value, 10.0)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _clean_user_id(value: Any) -> str | None:
    if value is None:
        return None

    raw = str(value).strip()
    if not raw or raw.lower() == "anon":
        return None

    try:
        return str(uuid.UUID(raw))
    except ValueError:
        return None


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None

    raw = str(value).strip()
    return raw or None


def _drop_none_values(value: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in value.items() if v is not None}