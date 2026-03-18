# /helpers/enrichment_completion.py
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from helpers.db import get_connection


TERMINAL_STATUSES = ("Succeeded", "Failed", "Superseded", "Expired")
ACTIVE_STATUSES = ("Pending", "Queued", "Leased")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def json_dumps_compact(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


@dataclass
class CompletionRunRow:
    run_id: str
    enricher_type: str
    subject_key: str
    job_offering_id: str
    user_id: str
    status: str
    requested_at: Any
    lease_token: Optional[str]
    lease_until: Optional[Any]


@dataclass
class CompletionOutcome:
    outcome: str  # completed | already_terminal | stale_ignored
    dispatches_created: int = 0


def fetch_run_for_update(cur, run_id: str) -> Optional[CompletionRunRow]:
    cur.execute(
        """
        SELECT
            RunId,
            EnricherType,
            SubjectKey,
            JobOfferingId,
            UserId,
            Status,
            RequestedAt,
            LeaseToken,
            LeaseUntil
        FROM dbo.EnrichmentRuns WITH (UPDLOCK, ROWLOCK)
        WHERE RunId = ?
        """,
        run_id,
    )
    row = cur.fetchone()
    if not row:
        return None

    return CompletionRunRow(
        run_id=str(row[0]),
        enricher_type=row[1],
        subject_key=row[2],
        job_offering_id=str(row[3]),
        user_id=str(row[4]),
        status=row[5],
        requested_at=row[6],
        lease_token=str(row[7]) if row[7] else None,
        lease_until=row[8],
    )


def get_latest_run_id(cur, enricher_type: str, subject_key: str) -> Optional[str]:
    cur.execute(
        """
        SELECT TOP 1 RunId
        FROM dbo.EnrichmentRuns
        WHERE EnricherType = ? AND SubjectKey = ?
        ORDER BY RequestedAt DESC, RunId DESC
        """,
        enricher_type,
        subject_key,
    )
    row = cur.fetchone()
    return str(row[0]) if row else None


def mark_run_superseded(cur, run_id: str, now: datetime) -> None:
    cur.execute(
        """
        UPDATE dbo.EnrichmentRuns
        SET Status = 'Superseded',
            CompletedAt = COALESCE(CompletedAt, ?),
            UpdatedAt = ?
        WHERE RunId = ?
          AND Status IN ('Pending', 'Queued', 'Leased')
        """,
        now, now, run_id,
    )


def update_run_completion(
    cur,
    *,
    run_id: str,
    status: str,
    result_json: Optional[Any],
    attributes_json: Optional[Any],
    error_code: Optional[str],
    error_message: Optional[str],
    now: datetime,
) -> None:
    cur.execute(
        """
        UPDATE dbo.EnrichmentRuns
        SET Status = ?,
            ResultJson = ?,
            EnrichmentAttributesJson = ?,
            ErrorCode = ?,
            ErrorMessage = ?,
            CompletedAt = ?,
            UpdatedAt = ?,
            LeaseToken = NULL,
            LeaseUntil = NULL
        WHERE RunId = ?
        """,
        status,
        json_dumps_compact(result_json) if result_json is not None else None,
        json_dumps_compact(attributes_json) if attributes_json is not None else None,
        error_code,
        error_message,
        now,
        now,
        run_id,
    )


def build_projection_dispatches(
    *,
    run: CompletionRunRow,
    completion_status: str,
    result_json: Optional[dict],
    now: datetime,
) -> list[dict]:
    if completion_status != "Succeeded":
        return []

    if run.enricher_type != "compatibility.v1":
        return []

    score = result_json.get("score") if isinstance(result_json, dict) else None
    summary = result_json.get("summary") if isinstance(result_json, dict) else None
    calculated_at = now.isoformat().replace("+00:00", "Z")

    payload = {
        "items": [
            {
                "jobId": run.job_offering_id,
                "userId": run.user_id,
                "runId": run.run_id,
                "enricherType": "compatibility.v1",
                "projectionType": "job-list.compatibility-score.v1",
                "status": "Succeeded",
                "score": score,
                "summary": summary,
                "calculatedAt": calculated_at,
            }
        ]
    }

    return [
        {
            "dispatchId": str(uuid.uuid4()),
            "runId": run.run_id,
            "enricherType": "compatibility.v1",
            "projectionType": "job-list.compatibility-score.v1",
            "targetDomain": "jobs",
            "targetKey": f"{run.job_offering_id}:{run.user_id}",
            "status": "Pending",
            "attemptCount": 0,
            "lastAttemptAt": None,
            "nextAttemptAt": now,
            "payloadJson": json_dumps_compact(payload),
            "lastError": None,
            "createdAt": now,
            "updatedAt": now,
        }
    ]


def insert_projection_dispatches(cur, dispatches: list[dict]) -> int:
    created = 0

    for d in dispatches:
        cur.execute(
            """
            IF NOT EXISTS (
                SELECT 1
                FROM dbo.EnrichmentProjectionDispatch
                WHERE RunId = ?
                  AND ProjectionType = ?
            )
            BEGIN
                INSERT INTO dbo.EnrichmentProjectionDispatch
                (
                    DispatchId,
                    RunId,
                    EnricherType,
                    ProjectionType,
                    TargetDomain,
                    TargetKey,
                    Status,
                    AttemptCount,
                    LastAttemptAt,
                    NextAttemptAt,
                    PayloadJson,
                    LastError,
                    CreatedAt,
                    UpdatedAt
                )
                VALUES
                (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            END
            """,
            d["runId"],
            d["projectionType"],
            d["dispatchId"],
            d["runId"],
            d["enricherType"],
            d["projectionType"],
            d["targetDomain"],
            d["targetKey"],
            d["status"],
            d["attemptCount"],
            d["lastAttemptAt"],
            d["nextAttemptAt"],
            d["payloadJson"],
            d["lastError"],
            d["createdAt"],
            d["updatedAt"],
        )
        if cur.rowcount and cur.rowcount > 0:
            created += 1

    return created


def complete_run_transactionally(
    *,
    run_id: str,
    status: str,
    result_json: Optional[dict],
    attributes_json: Optional[dict],
    error_code: Optional[str],
    error_message: Optional[str],
) -> CompletionOutcome:
    now = utcnow()

    conn = get_connection()
    try:
        conn.autocommit = False
        cur = conn.cursor()

        run = fetch_run_for_update(cur, run_id)
        if not run:
            raise ValueError("Run not found")

        if run.status in TERMINAL_STATUSES:
            conn.commit()
            return CompletionOutcome(outcome="already_terminal", dispatches_created=0)

        latest_run_id = get_latest_run_id(cur, run.enricher_type, run.subject_key)
        if latest_run_id and latest_run_id.lower() != run.run_id.lower():
            mark_run_superseded(cur, run.run_id, now)
            conn.commit()
            return CompletionOutcome(outcome="stale_ignored", dispatches_created=0)

        if run.status != "Leased":
            raise ValueError(f"Run cannot be completed from status '{run.status}'")

        update_run_completion(
            cur,
            run_id=run.run_id,
            status=status,
            result_json=result_json,
            attributes_json=attributes_json,
            error_code=error_code,
            error_message=error_message,
            now=now,
        )

        dispatches = build_projection_dispatches(
            run=run,
            completion_status=status,
            result_json=result_json,
            now=now,
        )
        created = insert_projection_dispatches(cur, dispatches)

        conn.commit()
        return CompletionOutcome(outcome="completed", dispatches_created=created)

    except Exception:
        conn.rollback()
        raise
    finally:
        try:
            conn.close()
        except Exception:
            pass