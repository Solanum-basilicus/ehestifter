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

def create_run_db(job_offering_id: str, user_id: str, enricher_type: str) -> Dict[str, Any]:
    """
    DB-only creation:
      - supersede existing active runs
      - insert new Pending run
      - returns minimal run dict (enough for snapshot + enqueue + response)
    """
    now = _utcnow()
    run_id = str(uuid.uuid4())
    subject_key = _subject_key(job_offering_id, user_id)

    conn = get_connection()
    try:
        conn.autocommit = False
        cur = conn.cursor()

        cur.execute(
            """
            UPDATE dbo.EnrichmentRuns
            SET Status = 'Superseded',
                UpdatedAt = ?
            WHERE EnricherType = ?
              AND SubjectKey = ?
              AND Status IN ('Pending','Queued','Leased')
            """,
            now, enricher_type, subject_key
        )

        # If you still want CVVersionId here, join it in or do a separate lookup.
        cv_version_id = None
        cur.execute(
            """
            SELECT CVVersionId
            FROM dbo.UserPreferences
            WHERE UserId = ?
            """,
            user_id,
        )
        row = cur.fetchone()
        if row:
            cv_version_id = row[0]

        cur.execute(
            """
            INSERT INTO dbo.EnrichmentRuns
            (RunId, EnricherType, SubjectKey, JobOfferingId, UserId,
             Status, RequestedAt, CVVersionId, UpdatedAt)
            VALUES (?, ?, ?, ?, ?, 'Pending', ?, ?, ?)
            """,
            run_id, enricher_type, subject_key, job_offering_id, user_id, now, cv_version_id, now
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
    Calls Worker Gateway to enqueue a SB message.
    Raises on any non-2xx response.
    """
    base_url = os.getenv("GATEWAY_API_BASE_URL")
    api_key  = os.getenv("GATEWAY_FUNCTION_KEY")

    if not base_url:
        raise Exception("Missing env: GATEWAY_API_BASE_URL")
    if not api_key:
        raise Exception("Missing env: GATEWAY_FUNCTION_KEY")

    url = f"{base_url.rstrip('/')}/gateway/dispatch"

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
        "x-functions-key": fn_key,
        "content-type": "application/json",
    }
    if corr:
        headers["x-correlation-id"] = corr

    logging.info("dispatch_via_gateway url=%s runId=%s corr=%s", url, run["runId"], corr)
    r = requests.post(url, json=payload, headers=headers, timeout=10)
    if r.status_code >= 300:
        raise Exception(f"Gateway dispatch failed {r.status_code}: {r.text}")


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