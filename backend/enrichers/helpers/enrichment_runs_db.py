# helpers/enrichment_runs_db.py
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional, Dict, Tuple

from helpers.db import get_connection


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(v: Any) -> Optional[str]:
    if v is None:
        return None
    try:
        return v.isoformat()
    except Exception:
        return str(v)


def normalize_run_row(d: Dict[str, Any]) -> Dict[str, Any]:
    # Match the API casing you already return from create_run
    return {
        "runId": str(d.get("RunId")),
        "enricherType": d.get("EnricherType"),
        "subjectKey": d.get("SubjectKey"),
        "jobOfferingId": str(d.get("JobOfferingId")),
        "userId": str(d.get("UserId")),
        "status": d.get("Status"),
        "requestedAt": _iso(d.get("RequestedAt")),
        "queuedAt": _iso(d.get("QueuedAt")),
        "leasedAt": _iso(d.get("LeasedAt")),
        "leaseUntil": _iso(d.get("LeaseUntil")),
        "leaseToken": str(d.get("LeaseToken")) if d.get("LeaseToken") else None,
        "cvVersionId": d.get("CVVersionId"),
        "inputSnapshotBlobPath": d.get("InputSnapshotBlobPath"),
        "errorCode": d.get("ErrorCode"),
        "errorMessage": d.get("ErrorMessage"),
        "completedAt": _iso(d.get("CompletedAt")),
        "updatedAt": _iso(d.get("UpdatedAt")),
        # keep parity with existing responses (even if null)
        "enrichmentAttributesJson": d.get("EnrichmentAttributesJson"),
        "resultJson": d.get("ResultJson"),
    }


def get_run_by_id(run_id: str) -> Optional[Dict[str, Any]]:
    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute("SELECT TOP 1 * FROM dbo.EnrichmentRuns WHERE RunId = ?", run_id)
        row = cur.fetchone()
        if not row:
            return None
        cols = [c[0] for c in cur.description]
        return normalize_run_row(dict(zip(cols, row)))
    finally:
        try:
            conn.close()
        except Exception:
            pass


def get_latest_run_id(subject_key: str, enricher_type: str) -> Optional[str]:
    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT TOP 1 RunId
            FROM dbo.EnrichmentRuns
            WHERE SubjectKey = ? AND EnricherType = ?
            ORDER BY RequestedAt DESC
            """,
            subject_key,
            enricher_type,
        )
        row = cur.fetchone()
        return str(row[0]) if row else None
    finally:
        try:
            conn.close()
        except Exception:
            pass


def try_lease_run(
    run_id: str,
    lease_token: str,
    lease_until: datetime,
    *,
    now: Optional[datetime] = None,
) -> Tuple[bool, Optional[str]]:
    """
    Returns (ok, error_code)
    error_code in: RUN_NOT_FOUND, NOT_LATEST, INVALID_STATUS, ALREADY_LEASED
    """
    now = now or _utcnow()

    conn = get_connection()
    try:
        conn.autocommit = False
        cur = conn.cursor()

        # 1) Load run row (minimal fields)
        cur.execute(
            """
            SELECT TOP 1 RunId, SubjectKey, EnricherType, Status, LeaseUntil
            FROM dbo.EnrichmentRuns
            WHERE RunId = ?
            """,
            run_id,
        )
        row = cur.fetchone()
        if not row:
            conn.rollback()
            return False, "RUN_NOT_FOUND"

        _run_id, subject_key, enricher_type, status, existing_lease_until = row

        # 2) Latest-run check
        cur.execute(
            """
            SELECT TOP 1 RunId
            FROM dbo.EnrichmentRuns
            WHERE SubjectKey = ? AND EnricherType = ?
            ORDER BY RequestedAt DESC
            """,
            subject_key,
            enricher_type,
        )
        latest = cur.fetchone()
        latest_id = str(latest[0]) if latest else None
        if latest_id is None or latest_id.lower() != str(run_id).lower():
            conn.rollback()
            return False, "NOT_LATEST"

        # 3) Status / lease checks
        # Allow leasing Pending as well (your create_run can remain Pending until Gateway exists)
        if status not in ("Pending", "Queued", "Leased"):
            conn.rollback()
            return False, "INVALID_STATUS"

        if status == "Leased":
            if existing_lease_until is not None:
                try:
                    if existing_lease_until > now:
                        conn.rollback()
                        return False, "ALREADY_LEASED"
                except Exception:
                    # if LeaseUntil is weird, be conservative: treat as leased
                    conn.rollback()
                    return False, "ALREADY_LEASED"

        # 4) Apply lease
        cur.execute(
            """
            UPDATE dbo.EnrichmentRuns
            SET Status = 'Leased',
                LeasedAt = ?,
                LeaseUntil = ?,
                LeaseToken = ?,
                UpdatedAt = ?
            WHERE RunId = ?
            """,
            now,
            lease_until,
            lease_token,
            now,
            run_id,
        )

        conn.commit()
        return True, None
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        try:
            conn.close()
        except Exception:
            pass


def get_input_snapshot_path(run_id: str) -> Optional[str]:
    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute("SELECT TOP 1 InputSnapshotBlobPath FROM dbo.EnrichmentRuns WHERE RunId = ?", run_id)
        row = cur.fetchone()
        return row[0] if row and row[0] else None
    finally:
        try:
            conn.close()
        except Exception:
            pass
