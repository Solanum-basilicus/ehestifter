"""Check that both Open Opportunities routes use the same score rule."""

import json
import sys
from pathlib import Path

import azure.functions as func
import pytest

JOBS_ROOT = Path(__file__).resolve().parents[1]
if str(JOBS_ROOT) not in sys.path:
    sys.path.insert(0, str(JOBS_ROOT))

from routes import jobs_list, jobs_open_query

USER_ID = "01234567-89ab-4cde-8f01-23456789abcd"


class FakeApp:
    def __init__(self):
        self.routes = {}

    def route(self, route, methods):
        def register(handler):
            self.routes[route] = handler
            return handler
        return register


class FakeCursor:
    def __init__(self):
        self.queries = []
        self.description = []

    def execute(self, query, params=()):
        self.queries.append((query, list(params)))
        return self

    def fetchone(self):
        return (0,)

    def fetchall(self):
        return []

    def close(self):
        pass


class FakeConnection:
    def __init__(self):
        self.cur = FakeCursor()

    def cursor(self):
        return self.cur

    def close(self):
        pass


def _request(method, url, params=None, body=None):
    return func.HttpRequest(
        method=method,
        url=url,
        headers={"x-user-id": USER_ID},
        params=params or {},
        body=json.dumps(body).encode() if body is not None else b"",
    )


@pytest.mark.parametrize("threshold", [None, "0", "7.5", "9.5"])
def test_list_route_uses_threshold_for_count_and_page(monkeypatch, threshold):
    conn = FakeConnection()
    monkeypatch.setattr(jobs_list, "get_connection", lambda: conn)
    monkeypatch.setattr(jobs_list, "active_location_model", lambda: "v1")
    app = FakeApp()
    jobs_list.register(app)
    params = {"category": "open"}
    if threshold is not None:
        params["minCompatibilityScore"] = threshold
    response = app.routes["jobs"](_request("GET", "https://jobs.test/api/jobs", params=params))

    assert response.status_code == 200
    assert json.loads(response.get_body())["minCompatibilityScore"] == (5.0 if threshold is None else float(threshold))
    assert len(conn.cur.queries) == 2
    for sql, args in conn.cur.queries:
        assert "cs.Score > ?" in sql
        expected = 5.0 if threshold is None else float(threshold)
        assert expected in args


@pytest.mark.parametrize("bad", ["9.6", "10", "-0.5", "nan", "1.25"])
def test_list_route_rejects_invalid_score_before_sql(monkeypatch, bad):
    monkeypatch.setattr(jobs_list, "get_connection", lambda: pytest.fail("SQL must not run"))
    app = FakeApp()
    jobs_list.register(app)
    response = app.routes["jobs"](_request("GET", "https://jobs.test/api/jobs", params={"category": "open", "minCompatibilityScore": bad}))
    assert response.status_code == 400


@pytest.mark.parametrize("threshold", [None, 0, 7.5, 9.5])
def test_structured_open_route_uses_threshold_for_count_and_page(monkeypatch, threshold):
    conn = FakeConnection()
    monkeypatch.setattr(jobs_open_query, "get_connection", lambda: conn)
    monkeypatch.setattr(jobs_open_query, "active_location_model", lambda: "v1")
    app = FakeApp()
    jobs_open_query.register(app)
    body = {}
    if threshold is not None:
        body["minCompatibilityScore"] = threshold
    response = app.routes["jobs/open/query"](_request("POST", "https://jobs.test/api/jobs/open/query", body=body))

    assert response.status_code == 200
    expected = 5.0 if threshold is None else float(threshold)
    assert json.loads(response.get_body())["minCompatibilityScore"] == expected
    assert len(conn.cur.queries) == 2
    for sql, args in conn.cur.queries:
        assert "cs.Score > ?" in sql
        assert expected in args


@pytest.mark.parametrize("bad", [True, 10, -1, 6.3, "NaN", []])
def test_structured_open_route_rejects_invalid_score_before_sql(monkeypatch, bad):
    monkeypatch.setattr(jobs_open_query, "get_connection", lambda: pytest.fail("SQL must not run"))
    app = FakeApp()
    jobs_open_query.register(app)
    response = app.routes["jobs/open/query"](_request("POST", "https://jobs.test/api/jobs/open/query", body={"minCompatibilityScore": bad}))
    assert response.status_code == 400
