from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Mapping

import httpx

from helpers.db import get_connection


_ALLOWED_REQUEST_SURFACES = {"web"}


def analytics_collection_enabled() -> bool:
    return os.getenv("ANALYTICS_COLLECTION_ENABLED", "0").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def source_surface_from_request(req) -> str | None:
    """
    Analytics v1 accepts web-originated Enrichment requests.

    Web Core marks calls with X-Source-Surface: web.
    """
    raw = (req.headers.get("X-Source-Surface") or "").strip().lower()
    if raw in _ALLOWED_REQUEST_SURFACES:
        return raw
    return None


def correlation_id_from_request(req) -> str | None:
    raw = (
        req.headers.get("x-correlation-id")
        or req.headers.get("x-ms-client-request-id")
        or ""
    ).strip()
    if not raw:
        return None
    if len(raw) > 100:
        return None
    return raw


def get_run_analytics_context(run_id: str) -> dict[str, Any] | None:
    """
    Small read-only lookup used after worker completion.

    Keeps the completion route from guessing job/user/enricher metadata.
    """
    cleaned_run_id = _clean_uuid(run_id)
    if not cleaned_run_id:
        return None

    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT RunId, EnricherType, JobOfferingId, UserId, Status
            FROM dbo.EnrichmentRuns
            WHERE RunId = ?
            """,
            cleaned_run_id,
        )
        row = cur.fetchone()
        if not row:
            return None

        return {
            "runId": str(row[0]),
            "enricherType": str(row[1]) if row[1] is not None else None,
            "jobOfferingId": str(row[2]) if row[2] is not None else None,
            "userId": str(row[3]) if row[3] is not None else None,
            "status": str(row[4]) if row[4] is not None else None,
        }
    finally:
        try:
            conn.close()
        except Exception:
            pass


def emit_enrichers_event(
    event_name: str,
    *,
    user_id: str | None,
    source_surface: str,
    subject_type: str | None = None,
    subject_id: str | None = None,
    correlation_id: str | None = None,
    properties: Mapping[str, Any] | None = None,
    producer_event_id: str | None = None,
    require_user_id: bool = True,
) -> bool:
    """
    Best-effort server-side Analytics emission from Enrichment Core.

    Design rules:
    - no exception escapes to product route;
    - no retry;
    - short timeout;
    - no function keys or full payload in logs;
    - no prompt/CV/job description/job title/company/summary fields.
    """
    if not analytics_collection_enabled():
        return False

    if source_surface not in {"web", "worker", "timer", "system"}:
        logging.warning(
            "analytics_enrichers_event_skipped_invalid_surface event=%s source_surface=%s",
            event_name,
            source_surface,
        )
        return False

    base_url = os.getenv("ANALYTICS_BASE_URL", "").rstrip("/")
    function_key = os.getenv("ANALYTICS_FUNCTION_KEY", "")

    if not base_url or not function_key:
        logging.warning(
            "analytics_enrichers_not_configured event=%s base_configured=%s key_configured=%s",
            event_name,
            bool(base_url),
            bool(function_key),
        )
        return False

    cleaned_user_id = _clean_uuid(user_id)
    if require_user_id and not cleaned_user_id:
        logging.warning(
            "analytics_enrichers_event_skipped_missing_user_id event=%s subject_type=%s subject_id=%s",
            event_name,
            subject_type,
            subject_id,
        )
        return False

    payload = {
        "eventName": event_name,
        "occurredAtUtc": _utc_now_iso(),
        "sourceDomain": "enrichers",
        "sourceSurface": source_surface,
        "userId": cleaned_user_id,
        "subjectType": _optional_str(subject_type),
        "subjectId": _optional_str(subject_id),
        "correlationId": _optional_str(correlation_id),
        "properties": _drop_none_values(dict(properties or {})),
        "schemaVersion": 1,
        "producerEventId": _optional_str(producer_event_id),
    }

    timeout = _analytics_timeout_seconds()

    try:
        with httpx.Client(timeout=timeout) as client:
            response = client.post(
                f"{base_url}/analytics/events",
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                    "x-functions-key": function_key,
                },
                json=payload,
            )

        if response.status_code >= 400:
            error_code = None
            try:
                error_body = response.json()
                if isinstance(error_body, dict):
                    error_code = error_body.get("error")
            except Exception:
                pass

            logging.warning(
                "analytics_enrichers_emit_failed event=%s status=%s error=%s subject_type=%s subject_id=%s",
                event_name,
                response.status_code,
                error_code,
                subject_type,
                subject_id,
            )
            return False

        return True

    except httpx.TimeoutException:
        logging.warning(
            "analytics_enrichers_emit_timeout event=%s timeout_seconds=%s subject_type=%s subject_id=%s",
            event_name,
            timeout,
            subject_type,
            subject_id,
        )
        return False

    except httpx.HTTPError as exc:
        logging.warning(
            "analytics_enrichers_emit_request_failed event=%s error_type=%s subject_type=%s subject_id=%s",
            event_name,
            type(exc).__name__,
            subject_type,
            subject_id,
        )
        return False

    except Exception as exc:
        logging.warning(
            "analytics_enrichers_emit_unexpected_failed event=%s error_type=%s subject_type=%s subject_id=%s",
            event_name,
            type(exc).__name__,
            subject_type,
            subject_id,
        )
        return False


def safe_failure_stage(value: Any) -> str | None:
    """
    Convert worker/Gateway errorCode into a bounded analytics enum-like value.

    Do not send raw errorMessage.
    """
    if value is None:
        return None

    raw = str(value).strip()
    if not raw:
        return None

    normalized = []
    for ch in raw[:80]:
        if ch.isalnum():
            normalized.append(ch.lower())
        elif ch in {"-", "_", " ", "."}:
            normalized.append("_")

    stage = "".join(normalized).strip("_")
    return stage or None


def extract_score(result_json: Any) -> float | None:
    if not isinstance(result_json, dict):
        return None

    raw = result_json.get("score")
    if raw is None:
        return None

    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None

    if value < 0:
        return 0.0
    if value > 10:
        return 10.0
    return value


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


def _clean_uuid(value: Any) -> str | None:
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
    