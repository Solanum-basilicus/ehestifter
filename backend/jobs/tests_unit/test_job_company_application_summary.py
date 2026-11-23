"""Offline tests for the private company application summary route."""

import importlib.util
import json
import sys
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

JOBS_ROOT = Path(__file__).resolve().parents[1]
if str(JOBS_ROOT) not in sys.path:
    sys.path.insert(0, str(JOBS_ROOT))

from helpers.auth import UnauthorizedError

MODULE_PATH = JOBS_ROOT / "routes" / "job_company_application_summary.py"
SPEC = importlib.util.spec_from_file_location("company_application_summary_for_test", MODULE_PATH)
summary_route = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(summary_route)

JOB_ID = "11111111-2222-3333-4444-555555555555"
USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
NOW = datetime(2026, 11, 23, 12, 30, 15, 123000)


class FakeApp:
    def route(self, route, methods):
        assert route == "jobs/{jobId}/company-application-summary"
        assert methods == ["GET"]

        def register(handler):
            self.handler = handler
            return handler
        return register


class FakeCursor:
    def __init__(self, row=None, failure=False):
        self.row = row
        self.failure = failure
        self.query = None
        self.params = None

    def execute(self, query, params):
        if self.failure:
            raise RuntimeError("Sensitive SQL details")
        self.query, self.params = query, params
        return self

    def fetchone(self):
        return self.row


class FakeConnection:
    def __init__(self, row=None, failure=False):
        self.fake_cursor = FakeCursor(row, failure)
        self.closed = 0

    def cursor(self):
        return self.fake_cursor

    def close(self):
        self.closed += 1


def invoke(monkeypatch, connection, *, job_id=JOB_ID, denied=False):
    if denied:
        def get_user(_req):
            raise UnauthorizedError("User ID required")
    else:
        def get_user(_req):
            return USER_ID

    monkeypatch.setattr(summary_route, "get_current_user_id", get_user)
    monkeypatch.setattr(summary_route, "get_connection", lambda: connection)
    app = FakeApp()
    summary_route.register(app)
    return app.handler(SimpleNamespace(route_params={"jobId": job_id}))


def test_summary_reads_private_counts_and_closes_connection(monkeypatch):
    connection = FakeConnection(("Fusion Consulting", "hiring", 2, 5, NOW))
    response = invoke(monkeypatch, connection)

    assert response.status_code == 200
    assert json.loads(response.get_body()) == {
        "available": True,
        "companyName": "Fusion Consulting",
        "matchBasis": "hiring",
        "last90Days": 2,
        "last365Days": 5,
        "asOfUtc": "2026-11-23T12:30:15.123Z",
    }
    assert connection.fake_cursor.params == (JOB_ID, USER_ID)
    assert connection.closed == 1


def test_summary_uses_posting_company_when_hiring_is_unknown(monkeypatch):
    connection = FakeConnection(("Agency", "posting", 0, 1, NOW))
    response = invoke(monkeypatch, connection)
    assert response.status_code == 200
    assert json.loads(response.get_body())["matchBasis"] == "posting"
    assert connection.closed == 1


def test_unknown_company_is_not_reported_as_zero(monkeypatch):
    connection = FakeConnection((None, None, 0, 0, NOW))
    response = invoke(monkeypatch, connection)
    data = json.loads(response.get_body())
    assert data["available"] is False
    assert data["companyName"] is None
    assert data["last90Days"] is None
    assert data["last365Days"] is None
    assert connection.closed == 1


def test_missing_or_deleted_target_job_returns_404(monkeypatch):
    connection = FakeConnection(None)
    response = invoke(monkeypatch, connection)
    assert response.status_code == 404
    assert connection.closed == 1


@pytest.mark.parametrize("job_id", ["not-a-guid", "", None])
def test_invalid_job_id_never_reaches_sql(monkeypatch, job_id):
    connection = FakeConnection(("Company", "hiring", 0, 0, NOW))
    response = invoke(monkeypatch, connection, job_id=job_id)
    assert response.status_code == 400
    assert connection.fake_cursor.query is None
    assert connection.closed == 0


def test_missing_user_id_never_reaches_sql(monkeypatch):
    connection = FakeConnection(("Company", "hiring", 0, 0, NOW))
    response = invoke(monkeypatch, connection, denied=True)
    assert response.status_code == 401
    assert connection.fake_cursor.query is None
    assert connection.closed == 0


def test_sql_error_does_not_leak_details_and_closes_connection(monkeypatch):
    connection = FakeConnection(failure=True)
    response = invoke(monkeypatch, connection)
    assert response.status_code == 500
    assert b"Sensitive SQL details" not in response.get_body()
    assert connection.closed == 1


def test_query_uses_active_jobs_and_first_status_event_per_job():
    sql = summary_route.COMPANY_APPLICATION_SQL
    assert "WHERE j.IsDeleted = 0" in sql
    assert "MIN(h.Timestamp) AS AppliedAt" in sql
    assert "GROUP BY h.JobOfferingId" in sql
    assert "h.ActorType = N'user' AND h.ActorId = ?" in sql
    assert "N'IGNORED'" in sql and "N'UNSET'" in sql
    assert "status-changed" in sql and "status_changed" in sql
    assert "JSON_VALUE(h.Details, '$.data.to')" in sql
    assert "trimmed.HiringName" in sql and "valid.PostingName" in sql
    assert "Latin1_General_100_CI_AS" in sql
    assert "DATEADD(day, -90" in sql and "DATEADD(day, -365" in sql
    assert "UserJobStatus" not in sql
    # No time filter is applied before MIN(h.Timestamp).
    assert "WHERE h.Timestamp" not in sql
