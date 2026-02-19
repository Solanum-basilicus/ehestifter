# enrichers/helpers/runs_create.py
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import Optional, Tuple, Any, Dict

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
