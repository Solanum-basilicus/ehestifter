"""Check Jobs API status sort SQL with a fake SQL connection."""

import json
import sys
from pathlib import Path

import azure.functions as func

JOBS_ROOT = Path(__file__).resolve().parents[1]
if str(JOBS_ROOT) not in sys.path:
    sys.path.insert(0, str(JOBS_ROOT))

from routes import jobs_list
from tests_unit.test_jobs_list_timeout import FakeApp, FakeConnection


def test_jobs_api_uses_progression_sql_with_stable_page_order(monkeypatch):
    connection = FakeConnection()
    monkeypatch.setattr(jobs_list, "get_connection", lambda: connection)
    monkeypatch.setattr(jobs_list, "active_location_model", lambda: "v1")
    app = FakeApp()
    jobs_list.register(app)
    request = func.HttpRequest(
        method="GET", url="https://jobs.test/api/jobs",
        headers={"x-user-id": "12345678-1234-4234-8234-123456789abc"},
        params={"category": "my", "sort": "status_progression"}, body=b"",
    )

    response = app.routes["jobs"](request)

    assert response.status_code == 200
    assert json.loads(response.get_body())["sort"] == "status_progression"
    select_sql, select_params = connection.cur.statements[1]
    assert "WHEN 'hm interview booked' THEN 60" in select_sql
    assert "WHEN 'applied' THEN 0" in select_sql
    assert "ELSE 20 END DESC" in select_sql
    assert "COALESCE(us.LastUpdated, j.UpdatedAt, j.CreatedAt) DESC" in select_sql
    assert "j.Id DESC" in select_sql
    assert select_sql.index("j.Id DESC") < select_sql.index("OFFSET ? ROWS")
    assert select_params[-2:] == [0, 25]
    assert connection.cur.closed and connection.closed


def test_jobs_api_default_sort_remains_created_desc(monkeypatch):
    connection = FakeConnection()
    monkeypatch.setattr(jobs_list, "get_connection", lambda: connection)
    monkeypatch.setattr(jobs_list, "active_location_model", lambda: "v1")
    app = FakeApp()
    jobs_list.register(app)
    request = func.HttpRequest(
        method="GET", url="https://jobs.test/api/jobs",
        headers={}, params={"category": "all"}, body=b"",
    )

    response = app.routes["jobs"](request)

    assert response.status_code == 200
    assert json.loads(response.get_body())["sort"] == "created_desc"
    assert "ORDER BY j.CreatedAt DESC" in connection.cur.statements[1][0]
