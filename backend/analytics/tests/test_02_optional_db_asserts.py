from __future__ import annotations

import uuid

import pytest
import requests


pytestmark = pytest.mark.db


def test_inserted_event_has_dispatch_row_when_db_asserts_enabled(
    base_url,
    jobs_headers,
    analytics_target,
    db_asserts_enabled,
    test_sql_connection_string,
):
    if not db_asserts_enabled:
        pytest.skip("Set ANALYTICS_TEST_ENABLE_DB_ASSERTS=1 to enable DB assertions.")

    pyodbc = pytest.importorskip("pyodbc")

    producer_event_id = f"pytest-db-{uuid.uuid4()}"
    job_id = "00000000-0000-0000-0000-000000000002"

    payload = {
        "eventName": "Job Status Changed",
        "occurredAtUtc": "2026-06-30T12:30:00.000Z",
        "sourceDomain": "jobs",
        "sourceSurface": "web",
        "userId": "00000000-0000-0000-0000-000000000001",
        "subjectType": "job",
        "subjectId": job_id,
        "correlationId": f"pytest-db-{analytics_target}",
        "properties": {
            "job_id": job_id,
            "new_status": "Applied",
            "is_final_status": False,
            "provider": "pytest",
            "test_event": True,
            "test_target": analytics_target,
        },
        "schemaVersion": 1,
        "producerEventId": producer_event_id,
    }

    r = requests.post(
        f"{base_url}/analytics/events",
        headers={**jobs_headers, "content-type": "application/json"},
        json=payload,
        timeout=15,
    )
    print("DB ASSERT INGEST:", r.status_code, r.text)
    assert r.status_code in (200, 202), r.text

    event_id = r.json()["eventId"]

    with pyodbc.connect(test_sql_connection_string, timeout=10) as conn:
        cursor = conn.cursor()

        event_row = cursor.execute(
            """
            SELECT EventId, EventName, SourceDomain, DistinctId, ProducerEventId, PropertiesJson
            FROM dbo.AnalyticsEvents
            WHERE SourceDomain = ?
              AND ProducerEventId = ?
            """,
            "jobs",
            producer_event_id,
        ).fetchone()

        assert event_row is not None
        assert str(event_row.EventId).lower() == event_id.lower()
        assert event_row.EventName == "Job Status Changed"
        assert event_row.SourceDomain == "jobs"
        assert event_row.DistinctId
        assert event_row.ProducerEventId == producer_event_id
        assert '"test_event":true' in event_row.PropertiesJson

        dispatch_row = cursor.execute(
            """
            SELECT Sink, Status, AttemptCount
            FROM dbo.AnalyticsDispatch
            WHERE EventId = ?
            """,
            event_id,
        ).fetchone()

        assert dispatch_row is not None
        assert dispatch_row.Sink == "mixpanel"
        assert dispatch_row.Status == "pending"
        assert dispatch_row.AttemptCount == 0
        