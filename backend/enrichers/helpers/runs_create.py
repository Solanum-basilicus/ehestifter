# enrichers/helpers/runs_create.py
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import Optional, Tuple, Any, Dict
import os
import logging
import requests

from helpers.db import get_connection

def _utcnow() -> datetime:
    return datetime.now(timezone.utc)

def _subject_key(job_offering_id: str, user_id: str) -> str:
    return f"{job_offering_id}:{user_id}"

# --- Gateway config selection ---

def _env_truthy(name: str, default: str = "0") -> bool:
    value = (os.getenv(name, default) or "").strip().lower()
    return value in ("1", "true", "yes", "y", "on")


def _require_gateway_url(name: str) -> str:
    value = (os.getenv(name) or "").strip().rstrip("/")
    if not value:
        raise Exception(f"Missing env: {name}")
    if not value.startswith(("http://", "https://")):
        raise Exception(f"Invalid env: {name} must start with http:// or https://")
    return value


def _require_gateway_key(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise Exception(f"Missing env: {name}")
    return value


def _selected_gateway_config() -> tuple[str, str, str]:
    """
    Select exactly one Gateway configuration.

    USE_GATEWAY_ALTERNATIVE=1 -> GCP Cloud Run Gateway
    anything else             -> primary Azure Gateway

    No automatic fallback. Dispatch may be non-idempotent from the caller's
    perspective if the Gateway enqueued the Service Bus message but the HTTP
    response was lost.
    """
    use_alt = _env_truthy("USE_GATEWAY_ALTERNATIVE")

    if use_alt:
        return (
            "alternative",
            _require_gateway_url("GATEWAY_ALTERNATIVE_API_BASE_URL"),
            _require_gateway_key("GATEWAY_ALTERNATIVE_FUNCTION_KEY"),
        )

    return (
        "primary",
        _require_gateway_url("GATEWAY_API_BASE_URL"),
        _require_gateway_key("GATEWAY_FUNCTION_KEY"),
    )


def decide_automatic_run(latest: dict | None, cv_version_id: str | None) -> str:
    """Return the Enrichment Core decision for an automatic request."""
    if not latest:
        return "created"
    status = str(latest.get("status") or "").lower()
    if status in ("pending", "queued", "leased"):
        return "reused"
    if status == "succeeded":
        previous_cv = str(latest.get("cvVersionId") or "").lower()
        current_cv = str(cv_version_id or "").lower()
        # Unknown CV versions keep the historical no-refresh behavior.
        if not previous_cv or previous_cv == current_cv:
            return "reused"
    if status == "failed" and latest.get("errorCode") == "INSUFFICIENT_JOB_DESCRIPTION":
        return "suppressed"
    return "created"


def create_run_db(
    job_offering_id: str, user_id: str, enricher_type: str,
    *, request_mode: str = "manual",
) -> Dict[str, Any]:
    """
    Decide and create inside one transaction. Manual requests always create.
    Automatic requests can reuse a run or suppress a permanent failure.
    """
    now = _utcnow()
    run_id = str(uuid.uuid4())
    subject_key = _subject_key(job_offering_id, user_id)

    conn = get_connection()
    try:
        conn.autocommit = False
        cur = conn.cursor()

        # Lock manual and automatic requests for the same subject.
        # Keep the transaction lock until commit or rollback.
        cur.execute(
            """
            SET NOCOUNT ON;
            DECLARE @lock_result int;
            EXEC @lock_result = sp_getapplock
                @Resource = ?, @LockMode = 'Exclusive',
                @LockOwner = 'Transaction', @LockTimeout = 10000;
            SELECT @lock_result;
            """,
            f"enrichment:{enricher_type}:{subject_key}",
        )
        lock_row = cur.fetchone()
        if lock_row is None or int(lock_row[0]) < 0:
            raise RuntimeError("Could not lock enrichment subject")

        cur.execute(
            "SELECT CVVersionId FROM dbo.UserPreferences WHERE UserId = ?",
            user_id,
        )
        row = cur.fetchone()
        cv_version_id = row[0] if row else None

        if request_mode == "automatic":
            cur.execute(
                """
                SELECT TOP 1 RunId, Status, CVVersionId, ErrorCode
                FROM dbo.EnrichmentRuns
                WHERE EnricherType = ? AND SubjectKey = ?
                ORDER BY RequestedAt DESC, RunId DESC
                """,
                enricher_type, subject_key,
            )
            latest_row = cur.fetchone()
            latest = None
            if latest_row:
                latest = {
                    "runId": str(latest_row[0]),
                    "status": latest_row[1],
                    "cvVersionId": latest_row[2],
                    "errorCode": latest_row[3],
                }
            decision = decide_automatic_run(latest, cv_version_id)
            if decision != "created":
                conn.commit()
                return {"runId": latest["runId"], "decision": decision}

        cur.execute(
            """
            UPDATE dbo.EnrichmentRuns
            SET Status = 'Superseded', UpdatedAt = ?
            WHERE EnricherType = ? AND SubjectKey = ?
              AND Status IN ('Pending','Queued','Leased')
            """,
            now, enricher_type, subject_key,
        )
        cur.execute(
            """
            INSERT INTO dbo.EnrichmentRuns
            (RunId, EnricherType, SubjectKey, JobOfferingId, UserId,
             Status, RequestedAt, CVVersionId, UpdatedAt)
            VALUES (?, ?, ?, ?, ?, 'Pending', ?, ?, ?)
            """,
            run_id, enricher_type, subject_key, job_offering_id, user_id, now, cv_version_id, now,
        )

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        try:
            conn.close()
        except Exception:
            pass

    return {
        "runId": run_id,
        "enricherType": enricher_type,
        "subjectKey": subject_key,
        "jobOfferingId": job_offering_id,
        "userId": user_id,
        "status": "Pending",
        "requestedAt": now.isoformat(),
        "cvVersionId": cv_version_id,
        "decision": "created",
    }

def mark_queued(run_id: str) -> None:
    now = _utcnow()
    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            UPDATE dbo.EnrichmentRuns
            SET Status = 'Queued',
                QueuedAt = ?,
                UpdatedAt = ?
            WHERE RunId = ? AND Status = 'Pending'
            """,
            now, now, run_id
        )
        conn.commit()
    finally:
        try:
            conn.close()
        except Exception:
            pass

def mark_failed(run_id: str, error_code: str, error_message: str) -> None:
    now = _utcnow()
    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            UPDATE dbo.EnrichmentRuns
            SET Status = 'Failed',
                ErrorCode = ?,
                ErrorMessage = ?,
                CompletedAt = ?,
                UpdatedAt = ?
            WHERE RunId = ? AND Status IN ('Pending','Queued')
            """,
            error_code, error_message, now, now, run_id
        )
        conn.commit()
    finally:
        try:
            conn.close()
        except Exception:
            pass


# --- Gateway dispatch + ops helpers ---

def dispatch_via_gateway(run: Dict[str, Any], input_snapshot_blob_path: str, corr: Optional[str] = None) -> None:
    """
    Calls selected Worker Gateway to enqueue a Service Bus message.
    Raises on any non-2xx response.

    Selection is explicit:
      USE_GATEWAY_ALTERNATIVE=0 -> primary Gateway
      USE_GATEWAY_ALTERNATIVE=1 -> alternative Gateway

    There is intentionally no automatic fallback.
    """
    gateway_kind, base_url, api_key = _selected_gateway_config()
    url = f"{base_url}/gateway/dispatch"

    payload = {
        "runId": run["runId"],
        "enricherType": run["enricherType"],
        "subjectKey": run["subjectKey"],
        "jobOfferingId": run["jobOfferingId"],
        "userId": run["userId"],
        "inputSnapshotBlobPath": input_snapshot_blob_path,
        "requestedAt": run.get("requestedAt"),
    }

    headers = {
        "x-functions-key": api_key,
        "content-type": "application/json",
    }
    if corr:
        headers["x-correlation-id"] = corr

    logging.info(
        "dispatch_via_gateway selected_gateway=%s base_url=%s path=/gateway/dispatch runId=%s corr=%s",
        gateway_kind,
        base_url,
        run["runId"],
        corr,
    )

    r = requests.post(url, json=payload, headers=headers, timeout=10)
    if r.status_code >= 300:
        raise Exception(
            f"Gateway dispatch failed selected_gateway={gateway_kind} "
            f"base_url={base_url} status={r.status_code}: {r.text}"
        )


def list_runs_by_status(status: str, limit: int = 100, offset: int = 0) -> tuple[int, list[Dict[str, Any]]]:
    """
    Returns (total_count, rows) for a given status.
    Allowed statuses: Pending, Queued (per your plan).
    Sorted oldest-first to drain backlog.
    """
    status = (status or "").strip()
    if status not in ("Pending", "Queued"):
        raise ValueError("status must be Pending or Queued")

    if limit < 1:
        limit = 1
    if limit > 500:
        limit = 500
    if offset < 0:
        offset = 0

    conn = get_connection()
    try:
        cur = conn.cursor()

        # Total count
        cur.execute(
            "SELECT COUNT(1) FROM dbo.EnrichmentRuns WHERE Status = ?",
            status
        )
        total = int(cur.fetchone()[0])

        # Page
        cur.execute(
            """
            SELECT
                RunId, EnricherType, SubjectKey, JobOfferingId, UserId,
                Status, RequestedAt, QueuedAt, CVVersionId, InputSnapshotBlobPath, UpdatedAt
            FROM dbo.EnrichmentRuns
            WHERE Status = ?
            ORDER BY RequestedAt ASC
            OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
            """,
            status, offset, limit
        )
        rows = cur.fetchall()
        cols = [c[0] for c in cur.description]
        items = [dict(zip(cols, r)) for r in rows]
        return total, items
    finally:
        try:
            conn.close()
        except Exception:
            pass


def mark_queued_by_gateway(run_id: str) -> tuple[str, bool]:
    """
    Idempotent transition:
      - Pending -> Queued (updated=true)
      - Queued -> Queued (updated=false)
      - else -> no change (updated=false), returns current status for route to decide response

    Returns: (current_status_after, updated)
    """
    now = _utcnow()
    conn = get_connection()
    try:
        conn.autocommit = False
        cur = conn.cursor()

        cur.execute("SELECT Status FROM dbo.EnrichmentRuns WHERE RunId = ?", run_id)
        row = cur.fetchone()
        if not row:
            raise ValueError("Run not found")

        current = row[0]

        if current == "Pending":
            cur.execute(
                """
                UPDATE dbo.EnrichmentRuns
                SET Status = 'Queued',
                    QueuedAt = ?,
                    UpdatedAt = ?
                WHERE RunId = ? AND Status = 'Pending'
                """,
                now, now, run_id
            )
            conn.commit()
            return "Queued", True

        if current == "Queued":
            conn.commit()
            return "Queued", False

        # Any other status: don't mutate
        conn.commit()
        return str(current), False

    except Exception:
        conn.rollback()
        raise
    finally:
        try:
            conn.close()
        except Exception:
            pass