"""Check SQL timeout and cleanup in the interactive Jobs list."""

import json
import sys
from pathlib import Path

import azure.functions as func
import pyodbc
import pytest

JOBS_ROOT = Path(__file__).resolve().parents[1]
if str(JOBS_ROOT) not in sys.path:
    sys.path.insert(0, str(JOBS_ROOT))

from routes import jobs_list


class FakeApp:
    def __init__(self):
        self.routes = {}

    def route(self, route, methods):
        def register(handler):
            self.routes[route] = handler
            return handler
        return register


class FakeCursor:
    def __init__(self, fail_at=None, rows=None):
        self.fail_at = fail_at
        self.rows = rows or []
        self.statements = []
        self.description = [("Id",), ("Title",)] if self.rows else []
        self.closed = False

    def execute(self, sql, params=()):
        self.statements.append((sql, list(params)))
        if len(self.statements) == self.fail_at:
            raise pyodbc.OperationalError("HYT00", "SQL query timeout")
        return self

    def fetchone(self):
        return (0,)

    def fetchall(self):
        return self.rows

    def close(self):
        self.closed = True


class FakeConnection:
    def __init__(self, fail_at=None, rows=None):
        self.timeout = 0
        self.timeout_at_cursor_creation = None
        self.cur = FakeCursor(fail_at, rows)
        self.closed = False

    def cursor(self):
        self.timeout_at_cursor_creation = self.timeout
        return self.cur

    def close(self):
        self.closed = True


def _call(monkeypatch, connection, params=None):
    monkeypatch.setattr(jobs_list, "get_connection", lambda: connection)
    monkeypatch.setattr(jobs_list, "active_location_model", lambda: "v1")
    app = FakeApp()
    jobs_list.register(app)
    request = func.HttpRequest(
        method="GET",
        url="https://jobs.test/api/jobs",
        headers={},
        params={"category": "all", **(params or {})},
        body=b"",
    )
    return app.routes["jobs"](request)


def test_jobs_list_sets_timeout_before_creating_cursor(monkeypatch):
    conn = FakeConnection()

    response = _call(monkeypatch, conn)

    assert response.status_code == 200
    assert conn.timeout_at_cursor_creation == jobs_list.JOBS_LIST_SQL_TIMEOUT_SECONDS == 5
    assert len(conn.cur.statements) == 2
    assert conn.cur.closed
    assert conn.closed


@pytest.mark.parametrize("fail_at", [1, 2])
def test_jobs_list_returns_504_and_closes_handles_on_sql_timeout(monkeypatch, fail_at):
    conn = FakeConnection(fail_at=fail_at)

    response = _call(monkeypatch, conn)

    assert response.status_code == 504
    assert json.loads(response.get_body()) == {
        "error": "jobs_query_timeout",
        "message": "The jobs search took too long. Change the filters and try again.",
    }
    assert len(conn.cur.statements) == fail_at
    assert conn.cur.closed
    assert conn.closed


def test_jobs_list_does_not_block_description_requests_in_api(monkeypatch):
    conn = FakeConnection()

    response = _call(monkeypatch, conn, {"search_field": "description", "q": "needle"})

    assert response.status_code == 200
    assert all("j.Description LIKE ?" in sql for sql, _ in conn.cur.statements)
    assert all("%needle%" in args for _, args in conn.cur.statements)
    assert conn.closed


def test_jobs_list_closes_handles_after_a_nonempty_page(monkeypatch):
    conn = FakeConnection(rows=[("01234567-89ab-4cde-8f01-23456789abcd", "Job")])

    response = _call(monkeypatch, conn)

    assert response.status_code == 200
    items = json.loads(response.get_body())["items"]
    assert len(items) == 1
    assert items[0]["Title"] == "Job"
    assert conn.cur.closed
    assert conn.closed
