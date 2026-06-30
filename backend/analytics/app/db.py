from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Any

import pyodbc

from app.config import AppConfig


def get_connection(config: AppConfig) -> pyodbc.Connection:
    if not config.sql_connection_string:
        raise RuntimeError("ANALYTICS_SQL_CONNECTION_STRING is not configured.")
    return pyodbc.connect(config.sql_connection_string, timeout=10)


def insert_event_with_dispatch(
    config: AppConfig,
    event: dict[str, Any],
    distinct_id: str | None,
) -> tuple[str, bool]:
    """
    Returns (event_id, was_duplicate).
    Idempotency is based on the filtered unique index over (SourceDomain, ProducerEventId).
    """
    properties_json = json.dumps(
        event["properties"],
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )

    event_id = str(uuid.uuid4())
    dispatch_id = str(uuid.uuid4())
    now_utc = datetime.utcnow()

    with get_connection(config) as conn:
        cursor = conn.cursor()

        if event["producerEventId"]:
            existing = _find_existing_event_id(
                cursor,
                event["sourceDomain"],
                event["producerEventId"],
            )
            if existing:
                conn.commit()
                return existing, True

        try:
            cursor.execute(
                """
                INSERT INTO dbo.AnalyticsEvents (
                    EventId,
                    OccurredAtUtc,
                    ReceivedAtUtc,
                    SourceDomain,
                    SourceSurface,
                    UserId,
                    DistinctId,
                    EventName,
                    SubjectType,
                    SubjectId,
                    CorrelationId,
                    ProducerEventId,
                    SchemaVersion,
                    PropertiesJson
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                event_id,
                event["occurredAtUtc"],
                now_utc,
                event["sourceDomain"],
                event["sourceSurface"],
                event["userId"],
                distinct_id,
                event["eventName"],
                event["subjectType"],
                event["subjectId"],
                event["correlationId"],
                event["producerEventId"],
                event["schemaVersion"],
                properties_json,
            )

            cursor.execute(
                """
                INSERT INTO dbo.AnalyticsDispatch (
                    DispatchId,
                    EventId,
                    Sink,
                    Status,
                    AttemptCount,
                    NextAttemptAtUtc,
                    LastAttemptAtUtc,
                    SentAtUtc,
                    LastErrorCode,
                    LastErrorJson
                )
                VALUES (?, ?, 'mixpanel', 'pending', 0, ?, NULL, NULL, NULL, NULL)
                """,
                dispatch_id,
                event_id,
                now_utc,
            )

            conn.commit()
            return event_id, False

        except pyodbc.IntegrityError:
            conn.rollback()

            if not event["producerEventId"]:
                raise

            with get_connection(config) as retry_conn:
                retry_cursor = retry_conn.cursor()
                existing = _find_existing_event_id(
                    retry_cursor,
                    event["sourceDomain"],
                    event["producerEventId"],
                )
                if not existing:
                    raise
                retry_conn.commit()
                return existing, True


def get_dispatch_status(config: AppConfig) -> dict[str, Any]:
    with get_connection(config) as conn:
        cursor = conn.cursor()
        row = cursor.execute(
            """
            SELECT
                SUM(CASE WHEN Status = 'pending' THEN 1 ELSE 0 END) AS PendingCount,
                SUM(CASE WHEN Status = 'sent'
                          AND SentAtUtc >= DATEADD(hour, -24, SYSUTCDATETIME())
                         THEN 1 ELSE 0 END) AS SentLast24h,
                SUM(CASE WHEN Status = 'retry' THEN 1 ELSE 0 END) AS FailedRetryable,
                SUM(CASE WHEN Status = 'dead' THEN 1 ELSE 0 END) AS DeadCount,
                MAX(CASE WHEN Status = 'sent' THEN SentAtUtc ELSE NULL END) AS LastSuccessfulDispatchAtUtc
            FROM dbo.AnalyticsDispatch
            """
        ).fetchone()
        conn.commit()

    last_success = row.LastSuccessfulDispatchAtUtc if row else None

    return {
        "pending": int(row.PendingCount or 0) if row else 0,
        "sentLast24h": int(row.SentLast24h or 0) if row else 0,
        "failedRetryable": int(row.FailedRetryable or 0) if row else 0,
        "dead": int(row.DeadCount or 0) if row else 0,
        "lastSuccessfulDispatchAtUtc": _format_utc(last_success),
    }


def _find_existing_event_id(
    cursor: pyodbc.Cursor,
    source_domain: str,
    producer_event_id: str,
) -> str | None:
    row = cursor.execute(
        """
        SELECT EventId
        FROM dbo.AnalyticsEvents
        WHERE SourceDomain = ?
          AND ProducerEventId = ?
        """,
        source_domain,
        producer_event_id,
    ).fetchone()

    if not row:
        return None

    return str(row.EventId)


def _format_utc(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat(timespec="seconds") + "Z"
    return str(value)

