# enrichers/timers/cleanup_runs.py
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone, timedelta
import azure.functions as func
from helpers.db import get_connection

logging.info("cleanup_runs module imported")

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


def _expire_queued(cur, now: datetime, queued_ttl_days: int) -> int:
    cutoff = now - timedelta(days=queued_ttl_days)
    cur.execute(
        """
        UPDATE dbo.EnrichmentRuns
        SET Status = 'Expired',
            ErrorCode = COALESCE(ErrorCode, 'QueueTTLExceeded'),
            ErrorMessage = COALESCE(ErrorMessage, 'Queued run expired by cleanup job'),
            CompletedAt = COALESCE(CompletedAt, ?),
            UpdatedAt = ?
        WHERE Status = 'Queued'
          AND QueuedAt IS NOT NULL
          AND QueuedAt < ?
        """,
        now, now, cutoff
    )
    return cur.rowcount or 0


def _expire_leased(cur, now: datetime, lease_grace_minutes: int) -> int:
    cutoff = now - timedelta(minutes=lease_grace_minutes)
    cur.execute(
        """
        UPDATE dbo.EnrichmentRuns
        SET Status = 'Expired',
            ErrorCode = COALESCE(ErrorCode, 'LeaseExpired'),
            ErrorMessage = COALESCE(ErrorMessage, 'Leased run expired by cleanup job'),
            CompletedAt = COALESCE(CompletedAt, ?),
            UpdatedAt = ?
        WHERE Status = 'Leased'
          AND LeaseUntil IS NOT NULL
          AND LeaseUntil < ?
        """,
        now, now, cutoff
    )
    return cur.rowcount or 0


def _fail_stuck_pending(cur, now: datetime, pending_fail_minutes: int) -> int:
    """
    Optional: if you set PENDING_FAIL_MINUTES > 0,
    mark very old Pending runs as Failed (snapshot exists but dispatch never happened, etc).
    """
    if pending_fail_minutes <= 0:
        return 0

    cutoff = now - timedelta(minutes=pending_fail_minutes)
    cur.execute(
        """
        UPDATE dbo.EnrichmentRuns
        SET Status = 'Failed',
            ErrorCode = COALESCE(ErrorCode, 'PendingTooLong'),
            ErrorMessage = COALESCE(ErrorMessage, 'Pending run failed by cleanup job'),
            CompletedAt = COALESCE(CompletedAt, ?),
            UpdatedAt = ?
        WHERE Status = 'Pending'
          AND RequestedAt < ?
        """,
        now, now, cutoff
    )
    return cur.rowcount or 0


def main(mytimer: func.TimerRequest) -> None:
    logging.info("cleanup_runs INVOKED past_due=%s", getattr(mytimer, "past_due", None))
    now = _utcnow()
    if mytimer.past_due:
        logging.warning("cleanup_runs timer is past due!")

    queued_ttl_days = _env_int("ENRICHERS_CLEANUP_QUEUED_TTL_DAYS", 14)
    lease_grace_min = _env_int("ENRICHERS_CLEANUP_LEASE_GRACE_MINUTES", 10)
    pending_fail_min = _env_int("ENRICHERS_CLEANUP_PENDING_FAIL_MINUTES", 0)  # disabled by default

    logging.info(
        "cleanup_runs start now=%s queued_ttl_days=%s lease_grace_min=%s pending_fail_min=%s",
        now.isoformat(), queued_ttl_days, lease_grace_min, pending_fail_min
    )

    conn = get_connection()
    try:
        conn.autocommit = False
        cur = conn.cursor()

        # ---- acquire SQL application lock ----
        cur.execute(
            """
            DECLARE @res INT;
            EXEC @res = sp_getapplock
                @Resource = 'cleanup_runs',
                @LockMode = 'Exclusive',
                @LockOwner = 'Transaction',
                @LockTimeout = 0;
            SELECT @res;
            """
        )
        lock_result = cur.fetchone()[0]

        # sp_getapplock return codes:
        # 0 = lock granted synchronously
        # 1 = lock granted after waiting
        # <0 = failure
        if lock_result < 0:
            logging.warning("cleanup_runs: could not acquire applock (result=%s), exiting", lock_result)
            conn.rollback()
            return

        logging.info("cleanup_runs: acquired applock")

        expired_queued = _expire_queued(cur, now, queued_ttl_days)
        expired_leased = _expire_leased(cur, now, lease_grace_min)
        failed_pending = _fail_stuck_pending(cur, now, pending_fail_min)

        conn.commit()

        logging.info(
            "cleanup_runs done expired_queued=%s expired_leased=%s failed_pending=%s",
            expired_queued, expired_leased, failed_pending
        )
    except Exception:
        conn.rollback()
        logging.exception("cleanup_runs failed")
        raise
    finally:
        try:
            conn.close()
        except Exception:
            pass