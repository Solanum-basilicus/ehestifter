from __future__ import annotations

import uuid

import requests


ZERO_USER_ID = "00000000-0000-0000-0000-000000000001"
ZERO_JOB_ID = "00000000-0000-0000-0000-000000000002"


def _pytest_producer_event_id(prefix: str) -> str:
    return f"pytest-{prefix}-{uuid.uuid4()}"


def _job_status_payload(producer_event_id: str, analytics_target: str) -> dict:
    return {
        "eventName": "Job Status Changed",
        "occurredAtUtc": "2026-06-30T12:30:00.000Z",
        "sourceDomain": "jobs",
        "sourceSurface": "web",
        "userId": ZERO_USER_ID,
        "subjectType": "job",
        "subjectId": ZERO_JOB_ID,
        "correlationId": f"pytest-{analytics_target}",
        "properties": {
            "job_id": ZERO_JOB_ID,
            "new_status": "Applied",
            "is_final_status": False,
            "provider": "pytest",
            "test_event": True,
            "test_target": analytics_target,
        },
        "schemaVersion": 1,
        "producerEventId": producer_event_id,
    }


def test_ping(base_url):
    r = requests.get(f"{base_url}/ping", timeout=10)
    print("PING:", r.status_code, r.text)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["service"] == "analytics"
    assert body["status"] == "ok"


def test_jobs_event_ingest_accepts_and_is_idempotent(
    base_url,
    jobs_headers,
    analytics_target,
):
    producer_event_id = _pytest_producer_event_id("jobs-status")
    payload = _job_status_payload(producer_event_id, analytics_target)

    r1 = requests.post(
        f"{base_url}/analytics/events",
        headers={**jobs_headers, "content-type": "application/json"},
        json=payload,
        timeout=15,
    )
    print("INGEST 1:", r1.status_code, r1.text)
    assert r1.status_code in (200, 202), r1.text

    body1 = r1.json()
    assert body1["status"] == "accepted"
    assert body1["idempotent"] is False
    assert uuid.UUID(body1["eventId"])

    r2 = requests.post(
        f"{base_url}/analytics/events",
        headers={**jobs_headers, "content-type": "application/json"},
        json=payload,
        timeout=15,
    )
    print("INGEST 2:", r2.status_code, r2.text)
    assert r2.status_code == 200, r2.text

    body2 = r2.json()
    assert body2["status"] == "accepted"
    assert body2["idempotent"] is True
    assert body2["eventId"].lower() == body1["eventId"].lower()


def test_dispatch_status_requires_scheduler_or_operator_key(
    base_url,
    jobs_headers,
    operator_headers,
):
    r_forbidden = requests.get(
        f"{base_url}/analytics/dispatch/status",
        headers=jobs_headers,
        timeout=10,
    )
    print("STATUS with jobs key:", r_forbidden.status_code, r_forbidden.text)
    assert r_forbidden.status_code == 403, r_forbidden.text

    r_ok = requests.get(
        f"{base_url}/analytics/dispatch/status",
        headers=operator_headers,
        timeout=10,
    )
    print("STATUS with operator key:", r_ok.status_code, r_ok.text)
    assert r_ok.status_code == 200, r_ok.text

    body = r_ok.json()
    for key in (
        "collectionEnabled",
        "mixpanelExportEnabled",
        "pending",
        "sentLast24h",
        "failedRetryable",
        "dead",
        "lastSuccessfulDispatchAtUtc",
    ):
        assert key in body, body


def test_scheduler_key_cannot_ingest(
    base_url,
    scheduler_headers,
):
    payload = {
        "eventName": "Job Status Changed",
        "occurredAtUtc": "2026-06-30T12:30:00.000Z",
        "sourceDomain": "jobs",
        "sourceSurface": "web",
        "properties": {},
        "schemaVersion": 1,
    }

    r = requests.post(
        f"{base_url}/analytics/events",
        headers={**scheduler_headers, "content-type": "application/json"},
        json=payload,
        timeout=10,
    )
    print("SCHEDULER INGEST:", r.status_code, r.text)
    assert r.status_code == 403, r.text
    assert r.json()["error"] == "forbidden_key"


def test_jobs_key_cannot_emit_users_domain(
    base_url,
    jobs_headers,
):
    payload = {
        "eventName": "CV Updated",
        "occurredAtUtc": "2026-06-30T12:30:00.000Z",
        "sourceDomain": "users",
        "sourceSurface": "web",
        "properties": {},
        "schemaVersion": 1,
    }

    r = requests.post(
        f"{base_url}/analytics/events",
        headers={**jobs_headers, "content-type": "application/json"},
        json=payload,
        timeout=10,
    )
    print("DOMAIN MISMATCH:", r.status_code, r.text)
    assert r.status_code == 403, r.text
    assert r.json()["error"] == "source_domain_key_mismatch"


def test_unknown_event_name_is_rejected(
    base_url,
    jobs_headers,
):
    payload = {
        "eventName": "Totally Unknown Event",
        "occurredAtUtc": "2026-06-30T12:30:00.000Z",
        "sourceDomain": "jobs",
        "sourceSurface": "web",
        "properties": {},
        "schemaVersion": 1,
    }

    r = requests.post(
        f"{base_url}/analytics/events",
        headers={**jobs_headers, "content-type": "application/json"},
        json=payload,
        timeout=10,
    )
    print("UNKNOWN EVENT:", r.status_code, r.text)
    assert r.status_code == 400, r.text
    assert r.json()["error"] == "unknown_event_name"


def test_forbidden_property_is_rejected(
    base_url,
    jobs_headers,
):
    payload = {
        "eventName": "Job Created",
        "occurredAtUtc": "2026-06-30T12:30:00.000Z",
        "sourceDomain": "jobs",
        "sourceSurface": "web",
        "properties": {
            "company_name": "Nope",
        },
        "schemaVersion": 1,
    }

    r = requests.post(
        f"{base_url}/analytics/events",
        headers={**jobs_headers, "content-type": "application/json"},
        json=payload,
        timeout=10,
    )
    print("FORBIDDEN PROPERTY:", r.status_code, r.text)
    assert r.status_code == 400, r.text
    assert r.json()["error"] == "forbidden_property"


def test_nested_forbidden_property_is_rejected(
    base_url,
    jobs_headers,
):
    payload = {
        "eventName": "Job Created",
        "occurredAtUtc": "2026-06-30T12:30:00.000Z",
        "sourceDomain": "jobs",
        "sourceSurface": "web",
        "properties": {
            "safe": {
                "job_description": "Nope",
            },
        },
        "schemaVersion": 1,
    }

    r = requests.post(
        f"{base_url}/analytics/events",
        headers={**jobs_headers, "content-type": "application/json"},
        json=payload,
        timeout=10,
    )
    print("NESTED FORBIDDEN PROPERTY:", r.status_code, r.text)
    assert r.status_code == 400, r.text
    assert r.json()["error"] == "forbidden_property"


def test_users_key_can_emit_cv_updated(
    base_url,
    users_headers,
    analytics_target,
):
    producer_event_id = _pytest_producer_event_id("cv-updated")
    cv_version_id = str(uuid.uuid4())

    payload = {
        "eventName": "CV Updated",
        "occurredAtUtc": "2026-06-30T12:30:00.000Z",
        "sourceDomain": "users",
        "sourceSurface": "web",
        "userId": ZERO_USER_ID,
        "subjectType": "cv",
        "subjectId": cv_version_id,
        "correlationId": f"pytest-{analytics_target}",
        "properties": {
            "cv_version_id": cv_version_id,
            "test_event": True,
            "test_target": analytics_target,
        },
        "schemaVersion": 1,
        "producerEventId": producer_event_id,
    }

    r = requests.post(
        f"{base_url}/analytics/events",
        headers={**users_headers, "content-type": "application/json"},
        json=payload,
        timeout=15,
    )
    print("USERS CV UPDATED:", r.status_code, r.text)
    assert r.status_code in (200, 202), r.text

    body = r.json()
    assert body["status"] == "accepted"
    assert uuid.UUID(body["eventId"])
    