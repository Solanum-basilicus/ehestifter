# /timers/dispatch_projections.py
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone, timedelta

import azure.functions as func
import requests

from helpers.db import get_connection

logging.info("dispatch_projections module imported")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _env_int(name: str, default: int) -> int:
    v = os.getenv(name)
    if not v:
        return default
    try:
        return int(v)
    except Exception:
        return default


def _env_str(name: str, default: str | None = None) -> str | None:
    v = os.getenv(name)
    return v if v else default


def _compute_next_attempt(now: datetime, attempt_count: int) -> datetime:
    # simple exponential-ish backoff: 1, 5, 15, 60, 180 minutes
    minutes = [1, 5, 15, 60, 180]
    idx = min(max(attempt_count - 1, 0), len(minutes) - 1)
    return now + timedelta(minutes=minutes[idx])


def _select_due_dispatches(cur, now: datetime, batch_size: int):
    cur.execute(
        """
        SELECT TOP (?)
            DispatchId,
            RunId,
            EnricherType,
            ProjectionType,
            TargetDomain,
            TargetKey,
            Status,
            AttemptCount,
            PayloadJson
        FROM dbo.EnrichmentProjectionDispatch WITH (READPAST)
        WHERE Status IN ('Pending', 'Failed')
          AND NextAttemptAt IS NOT NULL
          AND NextAttemptAt <= ?
        ORDER BY NextAttemptAt ASC, CreatedAt ASC
        """,
        batch_size, now,
    )
    return cur.fetchall()


def _mark_delivered(cur, dispatch_id: str, now: datetime):
    cur.execute(
        """
        UPDATE dbo.EnrichmentProjectionDispatch
        SET Status = 'Delivered',
            AttemptCount = AttemptCount + 1,
            LastAttemptAt = ?,
            LastError = NULL,
            UpdatedAt = ?
        WHERE DispatchId = ?
        """,
        now, now, dispatch_id,
    )


def _mark_retryable_failure(cur, dispatch_id: str, now: datetime, next_attempt_at: datetime, last_error: str):
    cur.execute(
        """
        UPDATE dbo.EnrichmentProjectionDispatch
        SET Status = 'Failed',
            AttemptCount = AttemptCount + 1,
            LastAttemptAt = ?,
            NextAttemptAt = ?,
            LastError = ?,
            UpdatedAt = ?
        WHERE DispatchId = ?
        """,
        now, next_attempt_at, last_error[:2000], now, dispatch_id,
    )


def _mark_deadletter(cur, dispatch_id: str, now: datetime, last_error: str):
    cur.execute(
        """
        UPDATE dbo.EnrichmentProjectionDispatch
        SET Status = 'DeadLetter',
            AttemptCount = AttemptCount + 1,
            LastAttemptAt = ?,
            LastError = ?,
            UpdatedAt = ?
        WHERE DispatchId = ?
        """,
        now, last_error[:2000], now, dispatch_id,
    )


def _post_jobs_projection(payload_json: str) -> requests.Response:
    base_url = _env_str("EHESTIFTER_JOBS_BASE_URL")
    function_key = _env_str("EHESTIFTER_JOBS_FUNCTION_KEY")

    if not base_url:
        raise RuntimeError("Missing EHESTIFTER_JOBS_BASE_URL")
    if not function_key:
        raise RuntimeError("Missing EHESTIFTER_JOBS_FUNCTION_KEY")

    url = f"{base_url.rstrip('/')}/internal/jobs/compatibility-projections:bulk-upsert"

    headers = {
        "Content-Type": "application/json",
        "x-functions-key": function_key,
    }

    session = requests.Session()
    return session.post(url, headers=headers, data=payload_json, timeout=60)


def _deliver_one(dispatch_row, max_attempts: int) -> tuple[str, str | None]:
    """
    Returns:
      ("delivered", None)
      ("retry", "...error...")
      ("deadletter", "...error...")
    """
    target_domain = dispatch_row.TargetDomain
    projection_type = dispatch_row.ProjectionType
    attempt_count = int(dispatch_row.AttemptCount or 0)
    payload_json = dispatch_row.PayloadJson

    try:
        if target_domain != "jobs":
            return ("deadletter", f"Unsupported target domain: {target_domain}")

        if projection_type != "job-list.compatibility-score.v1":
            return ("deadletter", f"Unsupported projection type: {projection_type}")

        resp = _post_jobs_projection(payload_json)

        if 200 <= resp.status_code < 300:
            logging.info(
                "dispatch_projections: jobs API success status=%s body=%s",
                resp.status_code,
                resp.text[:1000],
            )
            return ("delivered", None)

        logging.warning(
            "dispatch_projections: jobs API failure status=%s body=%s",
            resp.status_code,
            resp.text[:1000],
        )

        if resp.status_code in (408, 409, 425, 429, 500, 502, 503, 504):
            msg = f"Jobs API transient failure {resp.status_code}: {resp.text[:1000]}"
            if attempt_count + 1 >= max_attempts:
                return ("deadletter", msg)
            return ("retry", msg)

        return ("deadletter", f"Jobs API non-retryable failure {resp.status_code}: {resp.text[:1000]}")

    except requests.RequestException as ex:
        msg = f"HTTP error: {type(ex).__name__}: {str(ex)}"
        if attempt_count + 1 >= max_attempts:
            return ("deadletter", msg)
        return ("retry", msg)

    except Exception as ex:
        msg = f"Unexpected error: {type(ex).__name__}: {str(ex)}"
        if attempt_count + 1 >= max_attempts:
            return ("deadletter", msg)
        return ("retry", msg)


def main(mytimer: func.TimerRequest) -> None:
    logging.info("dispatch_projections INVOKED past_due=%s", getattr(mytimer, "past_due", None))
    now = _utcnow()

    if mytimer.past_due:
        logging.warning("dispatch_projections timer is past due!")

    batch_size = _env_int("ENRICHERS_PROJECTION_DISPATCH_BATCH_SIZE", 50)
    max_attempts = _env_int("ENRICHERS_PROJECTION_DISPATCH_MAX_ATTEMPTS", 8)

    conn = get_connection()
    try:
        conn.autocommit = False
        cur = conn.cursor()

        cur.execute(
            """
            DECLARE @res INT;
            EXEC @res = sp_getapplock
                @Resource = 'dispatch_projections',
                @LockMode = 'Exclusive',
                @LockOwner = 'Transaction',
                @LockTimeout = 0;
            SELECT @res;
            """
        )
        lock_result = cur.fetchone()[0]

        if lock_result < 0:
            logging.warning("dispatch_projections: could not acquire applock (result=%s), exiting", lock_result)
            conn.rollback()
            return

        rows = _select_due_dispatches(cur, now, batch_size)
        conn.commit()  # release applock sooner; selection done

        logging.info("dispatch_projections: picked %s rows", len(rows))

        delivered = 0
        retried = 0
        deadlettered = 0

        for row in rows:
            dispatch_id = str(row.DispatchId)
            status, error = _deliver_one(row, max_attempts)
            step_now = _utcnow()

            logging.info(
                "dispatch_projections: dispatch_id=%s run_id=%s projection_type=%s target_domain=%s attempt_count=%s outcome=%s error=%s",
                str(row.DispatchId),
                str(row.RunId),
                row.ProjectionType,
                row.TargetDomain,
                int(row.AttemptCount or 0),
                status,
                error,
            )

            inner = get_connection()
            try:
                inner.autocommit = False
                icur = inner.cursor()

                if status == "delivered":
                    _mark_delivered(icur, dispatch_id, step_now)
                    delivered += 1
                elif status == "retry":
                    next_attempt = _compute_next_attempt(step_now, int(row.AttemptCount or 0) + 1)
                    _mark_retryable_failure(icur, dispatch_id, step_now, next_attempt, error or "retry")
                    retried += 1
                else:
                    _mark_deadletter(icur, dispatch_id, step_now, error or "deadletter")
                    deadlettered += 1

                inner.commit()
            except Exception:
                inner.rollback()
                logging.exception("dispatch_projections: failed updating dispatch row %s", dispatch_id)
                raise
            finally:
                inner.close()

        logging.info(
            "dispatch_projections done delivered=%s retried=%s deadlettered=%s",
            delivered, retried, deadlettered
        )

    except Exception:
        conn.rollback()
        logging.exception("dispatch_projections failed")
        raise
    finally:
        try:
            conn.close()
        except Exception:
            pass
        