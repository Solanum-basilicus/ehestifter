"""Safe, low-volume diagnostics for Enrichment run requests."""

import json
import logging
import re
import uuid

import httpx
import pyodbc
import requests

from helpers.db import DatabaseConnectionError, sql_state


_STAGES = frozenset({
    "run_create", "run_readback", "analytics", "job_snapshot", "cv_snapshot",
    "snapshot_validate", "blob_upload", "snapshot_path_update",
    "gateway_dispatch", "mark_queued",
})
_UUID = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\Z"
)


def safe_correlation_id(headers):
    """Do not log client text that is not a UUID."""
    supplied = headers.get("x-correlation-id") or headers.get("x-ms-client-request-id")
    return supplied.lower() if isinstance(supplied, str) and _UUID.fullmatch(supplied) else str(uuid.uuid4())


class GatewayHTTPError(RuntimeError):
    """The selected Gateway returned a non-success HTTP response."""

    def __init__(self, status_code, gateway_kind):
        self.status_code = status_code
        self.gateway_kind = gateway_kind
        super().__init__("Gateway dispatch returned an HTTP error")


def classify_failure(exc, stage):
    """Return fixed values. Do not read an exception message."""
    if isinstance(exc, GatewayHTTPError):
        return "gateway_http_5xx" if exc.status_code >= 500 else "gateway_http_4xx"
    if isinstance(exc, DatabaseConnectionError):
        return "db_connection_" + exc.reason
    if stage == "run_create" and isinstance(exc, SubjectLockError):
        return "db_subject_lock"
    if isinstance(exc, pyodbc.Error):
        return "db_sql"
    if isinstance(exc, (httpx.TimeoutException, requests.exceptions.Timeout, TimeoutError)):
        return "upstream_timeout"
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        return "upstream_http_5xx" if status >= 500 else "upstream_http_4xx"
    if isinstance(exc, (httpx.RequestError, requests.exceptions.RequestException)):
        return "upstream_transport"
    if stage in ("job_snapshot", "cv_snapshot") and isinstance(exc, (ValueError, TypeError)):
        return "upstream_invalid_response"
    if stage == "snapshot_validate" and isinstance(exc, (ValueError, TypeError, KeyError, AttributeError)):
        return "invalid_snapshot"
    if stage in ("blob_upload", "snapshot_path_update"):
        return "snapshot_storage"
    if stage in ("run_create", "run_readback", "mark_queued"):
        return "db_operation"
    if stage == "gateway_dispatch":
        return "gateway_dispatch"
    return "internal_error"


class SubjectLockError(RuntimeError):
    """The SQL subject lock was not acquired."""


def diagnostic(stage, exc):
    safe_stage = stage if stage in _STAGES else "unknown"
    result = {"stage": safe_stage, "category": classify_failure(exc, safe_stage)}
    state = exc.sql_state if isinstance(exc, DatabaseConnectionError) else (
        sql_state(exc) if isinstance(exc, pyodbc.Error) else None
    )
    if isinstance(state, str) and re.fullmatch(r"[A-Z0-9]{5}", state):
        result["sqlState"] = state
    if isinstance(exc, GatewayHTTPError):
        if 300 <= exc.status_code <= 599:
            result["upstreamStatus"] = exc.status_code
        if exc.gateway_kind in ("primary", "alternative"):
            result["gatewayTarget"] = exc.gateway_kind
    return result


def log_failure(stage, exc, corr, run_id=None):
    """Emit one safe error record. Never emit a traceback or response body."""
    result = diagnostic(stage, exc)
    logging.error(
        "enrichment_run_failure path=/enrichment/runs stage=%s category=%s sqlState=%s upstreamStatus=%s gatewayTarget=%s corr=%s runId=%s",
        result["stage"], result["category"], result.get("sqlState") or "none",
        result.get("upstreamStatus") or "none", result.get("gatewayTarget") or "none",
        corr, run_id or "none",
    )
    return result


def diagnostic_headers(result):
    headers = {
        "x-enrichment-failure-stage": result["stage"],
        "x-enrichment-failure-category": result["category"],
    }
    if result.get("sqlState"):
        headers["x-enrichment-failure-sqlstate"] = result["sqlState"]
    if result.get("upstreamStatus"):
        headers["x-enrichment-failure-upstream-status"] = str(result["upstreamStatus"])
    if result.get("gatewayTarget"):
        headers["x-enrichment-failure-gateway-target"] = result["gatewayTarget"]
    return headers


def internal_error_response(result):
    """Do not expose an exception or internal data to the caller."""
    import azure.functions as func

    return func.HttpResponse(
        json.dumps({"error": "Enrichment request failed"}),
        status_code=500,
        mimetype="application/json",
        headers=diagnostic_headers(result),
    )
