from __future__ import annotations

import json
import logging
import os
import socket
import uuid
from datetime import datetime, timezone
from typing import Any, Mapping
from urllib import error, request


_ALLOWED_SOURCE_SURFACES = {"web"}


def analytics_collection_enabled() -> bool:
    return os.getenv("ANALYTICS_COLLECTION_ENABLED", "0").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def source_surface_from_request(req) -> str | None:
    """
    Analytics v1 is web-only for Jobs.

    Web Core marks its domain calls with X-Source-Surface: web.
    Telegram/bot/system callers should not get Jobs analytics in this milestone.
    """
    raw = (req.headers.get("X-Source-Surface") or "").strip().lower()
    if raw in _ALLOWED_SOURCE_SURFACES:
        return raw
    return None

def correlation_id_from_request(req) -> str | None:
    raw = (req.headers.get("X-Correlation-Id") or "").strip()
    if not raw:
        return None
    if len(raw) > 100:
        return None
    return raw

def emit_jobs_event(
    event_name: str,
    *,
    req,
    user_id: str | None,
    subject_type: str | None = None,
    subject_id: str | None = None,
    correlation_id: str | None = None,
    properties: Mapping[str, Any] | None = None,
    producer_event_id: str | None = None,
    require_user_id: bool = True,
) -> bool:
    """
    Best-effort server-side Analytics emission from Jobs.

    Design rules:
    - no exception escapes to product route;
    - no retry;
    - short timeout;
    - no function keys or full payload in logs;
    - only emits web-originated events in v1.
    """
    if not analytics_collection_enabled():
        return False

    source_surface = source_surface_from_request(req)
    if not source_surface:
        logging.info("analytics_jobs_event_skipped_non_web event=%s", event_name)
        return False

    base_url = os.getenv("ANALYTICS_BASE_URL", "").rstrip("/")
    function_key = os.getenv("ANALYTICS_FUNCTION_KEY", "")

    if not base_url or not function_key:
        logging.warning(
            "analytics_jobs_not_configured event=%s base_configured=%s key_configured=%s",
            event_name,
            bool(base_url),
            bool(function_key),
        )
        return False

    cleaned_user_id = _clean_user_id(user_id)
    if require_user_id and not cleaned_user_id:
        logging.warning(
            "analytics_jobs_event_skipped_missing_user_id event=%s subject_type=%s subject_id=%s",
            event_name,
            subject_type,
            subject_id,
        )
        return False

    payload = {
        "eventName": event_name,
        "occurredAtUtc": _utc_now_iso(),
        "sourceDomain": "jobs",
        "sourceSurface": source_surface,
        "userId": cleaned_user_id,
        "subjectType": _optional_str(subject_type),
        "subjectId": _optional_str(subject_id),
        "correlationId": _optional_str(correlation_id),
        "properties": _drop_none_values(dict(properties or {})),
        "schemaVersion": 1,
        "producerEventId": _optional_str(producer_event_id),
    }

    body = json.dumps(payload).encode("utf-8")
    timeout = _analytics_timeout_seconds()

    analytics_req = request.Request(
        f"{base_url}/analytics/events",
        data=body,
        method="POST",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "x-functions-key": function_key,
        },
    )

    try:
        with request.urlopen(analytics_req, timeout=timeout) as response:
            status = getattr(response, "status", 200)
            if status >= 400:
                logging.warning(
                    "analytics_jobs_emit_failed event=%s status=%s subject_type=%s subject_id=%s",
                    event_name,
                    status,
                    subject_type,
                    subject_id,
                )
                return False
            return True

    except error.HTTPError as exc:
        error_code = _try_read_error_code(exc)
        logging.warning(
            "analytics_jobs_emit_http_failed event=%s status=%s error=%s subject_type=%s subject_id=%s",
            event_name,
            exc.code,
            error_code,
            subject_type,
            subject_id,
        )
        return False

    except (error.URLError, socket.timeout, TimeoutError) as exc:
        logging.warning(
            "analytics_jobs_emit_request_failed event=%s error_type=%s subject_type=%s subject_id=%s",
            event_name,
            type(exc).__name__,
            subject_type,
            subject_id,
        )
        return False

    except Exception as exc:
        logging.warning(
            "analytics_jobs_emit_unexpected_failed event=%s error_type=%s subject_type=%s subject_id=%s",
            event_name,
            type(exc).__name__,
            subject_type,
            subject_id,
        )
        return False


def _try_read_error_code(exc: error.HTTPError) -> str | None:
    try:
        raw = exc.read(600).decode("utf-8", errors="replace")
        data = json.loads(raw)
        if isinstance(data, dict):
            value = data.get("error")
            return str(value) if value else None
    except Exception:
        return None
    return None


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
    if not raw:
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