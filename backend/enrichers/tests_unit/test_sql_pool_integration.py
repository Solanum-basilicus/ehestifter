"""Test Enrichers SQL leases and failure diagnostics without Azure SQL."""

import logging
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import azure.functions as func
import pytest

from helpers import db
from helpers.sql_pool import ConnectionPool, PoolWaitTimeout
from helpers.timing import current, timed_handler


class FakeCursor:
    def __init__(self, connection):
        self.connection = connection

    def execute(self, statement, *_params):
        if self.connection.fail_query:
            raise db.pyodbc.OperationalError("08S01", "private SQL and CV data")
        return self

    def fetchone(self):
        return (1,)

    def close(self):
        pass


class FakeConnection:
    def __init__(self, *, fail_query=False, fail_rollback=False):
        self.timeout = 0
        self.autocommit = False
        self.fail_query = fail_query
        self.fail_rollback = fail_rollback
        self.rollbacks = 0
        self.closes = 0
        self.commits = 0
        self.last_cursor_timeout = None

    def cursor(self):
        self.last_cursor_timeout = self.timeout
        return FakeCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1
        if self.fail_rollback:
            raise RuntimeError("private rollback details")

    def close(self):
        self.closes += 1


class Request:
    def __init__(self, corr=None):
        self.headers = {"x-correlation-id": corr} if corr else {}


def fake_pool(monkeypatch, *, max_size=1, wait_seconds=0.03):
    monkeypatch.setattr(db, "POOL_ENABLED", True)
    pool = ConnectionPool(max_size=max_size, wait_seconds=wait_seconds)
    monkeypatch.setattr(db, "_pool", pool)
    made = []

    def connect(*_args, **_kwargs):
        connection = FakeConnection()
        made.append(connection)
        return connection

    monkeypatch.setattr(db.pyodbc, "connect", connect)
    return pool, made


def test_request_end_returns_open_lease_and_reports_pool_hit(monkeypatch, caplog):
    _, opened = fake_pool(monkeypatch)

    @timed_handler
    def route(_request):
        conn = db.get_connection()
        conn.cursor().execute("SELECT 1").fetchone()
        # Intentionally omit close: the request boundary must release it.
        return func.HttpResponse("ok", status_code=200)

    with caplog.at_level(logging.ERROR):
        first, second = route(Request()), route(Request())
    assert len(opened) == 1
    assert opened[0].rollbacks == 2
    assert opened[0].closes == 0
    assert 'db_pool;desc="new"' in first.headers["Server-Timing"]
    assert 'db_pool;desc="hit"' in second.headers["Server-Timing"]
    assert "dbconn;dur=" in second.headers["Server-Timing"]
    assert "sql;dur=" in second.headers["Server-Timing"]
    assert 'sql_count;desc="1"' in second.headers["Server-Timing"]
    assert 'db_pool_hit;desc="1"' in second.headers["Server-Timing"]
    assert 'db_pool_new;desc="1"' in first.headers["Server-Timing"]
    assert current() is None
    assert not caplog.records


def test_explicit_close_and_request_cleanup_release_once(monkeypatch):
    _, opened = fake_pool(monkeypatch)

    @timed_handler
    def route(_req):
        conn = db.get_connection()
        conn.close()
        return func.HttpResponse("ok")

    route(Request())
    assert opened[0].rollbacks == 1


def test_timers_reuse_connections_without_http_context(monkeypatch):
    _, opened = fake_pool(monkeypatch)
    first = db.get_connection()
    first.cursor().execute("SELECT 1")
    first.close()
    second = db.get_connection()
    second.cursor().execute("SELECT 1")
    second.close()
    assert len(opened) == 1
    assert opened[0].rollbacks == 2


def test_broken_query_connection_is_discarded_even_in_timer(monkeypatch):
    _, opened = fake_pool(monkeypatch)
    conn = db.get_connection()
    opened[0].fail_query = True
    with pytest.raises(db.pyodbc.OperationalError, match="private"):
        conn.cursor().execute("SELECT private")
    conn.close()
    assert opened[0].closes == 1
    assert opened[0].rollbacks == 0
    replacement = db.get_connection()
    assert len(opened) == 2
    replacement.close()


def test_request_connection_failure_is_safe_and_classified(monkeypatch, caplog):
    fake_pool(monkeypatch)

    def connect(*_args, **_kwargs):
        raise db.pyodbc.OperationalError("HYT00", "secret password and SQL text")

    monkeypatch.setattr(db.pyodbc, "connect", connect)

    @timed_handler
    def route(req):
        with pytest.raises(db.DatabaseConnectionError) as err:
            db.get_connection()
        assert err.value.reason == "operational"
        return func.HttpResponse(str(err.value), status_code=500)

    with caplog.at_level(logging.ERROR):
        response = route(Request("private injected correlation text"))
    assert response.headers["x-enrichment-failure-stage"] == "db_acquire"
    assert response.headers["x-enrichment-failure-category"] == "db_connection_operational"
    assert response.headers["x-enrichment-failure-sqlstate"] == "HYT00"
    assert response.headers["x-correlation-id"] != "private injected correlation text"
    assert caplog.text.count("enrichers_sql_failure") == 1
    assert "secret" not in caplog.text + response.get_body().decode()


def test_pool_wait_timeout_is_safe(monkeypatch):
    fake_pool(monkeypatch, wait_seconds=0)
    first = db.get_connection()
    try:
        with pytest.raises(db.DatabaseConnectionError) as err:
            db.get_connection()
        assert err.value.reason == "pool_wait"
    finally:
        first.close()


def test_pool_disabled_closes_physical_connection(monkeypatch):
    _, opened = fake_pool(monkeypatch)
    monkeypatch.setattr(db, "POOL_ENABLED", False)

    @timed_handler
    def route(_req):
        db.get_connection().close()
        return func.HttpResponse("ok")

    assert 'db_pool;desc="disabled"' in route(Request()).headers["Server-Timing"]
    assert len(opened) == 1
    assert opened[0].closes == 1


def test_idle_validation_sets_short_cursor_timeout(monkeypatch):
    conn = FakeConnection()
    conn.timeout = 18
    db._validate(conn)
    assert conn.last_cursor_timeout == 2
    assert conn.timeout == 18
    assert conn.rollbacks == 1


def test_concurrent_http_requests_do_not_share_active_lease(monkeypatch):
    _, opened = fake_pool(monkeypatch, max_size=2, wait_seconds=2)
    barrier = Barrier(2)

    @timed_handler
    def route(_req):
        conn = db.get_connection()
        barrier.wait(timeout=5)
        conn.cursor().execute("SELECT 1")
        return func.HttpResponse("ok")

    with ThreadPoolExecutor(max_workers=2) as executor:
        future1 = executor.submit(route, Request())
        future2 = executor.submit(route, Request())
        assert future1.result(timeout=5).status_code == 200
        assert future2.result(timeout=5).status_code == 200
    assert len(opened) == 2


def test_rollback_failure_closes_socket(monkeypatch):
    _, opened = fake_pool(monkeypatch)
    opened.clear()
    conn = db.get_connection()
    opened[0].fail_rollback = True
    conn.close()
    assert opened[0].closes == 1
    other = db.get_connection()
    assert len(opened) == 2
    other.close()


def test_multiple_sql_leases_are_counted_in_one_request(monkeypatch):
    _, opened = fake_pool(monkeypatch)

    @timed_handler
    def route(_req):
        first = db.get_connection()
        first.close()
        second = db.get_connection()
        second.close()
        return func.HttpResponse("ok")

    response = route(Request())
    assert len(opened) == 1
    assert 'db_pool_new;desc="1"' in response.headers["Server-Timing"]
    assert 'db_pool_hit;desc="1"' in response.headers["Server-Timing"]


def test_autocommit_is_reset_before_pool_reuse(monkeypatch):
    _, opened = fake_pool(monkeypatch)
    connection = db.get_connection()
    connection.autocommit = True
    connection.close()
    assert opened[0].autocommit is False
    second = db.get_connection()
    assert second.autocommit is False
    second.close()


def test_subject_lock_batch_restores_nocount_and_discards_on_error(monkeypatch):
    """A failed SET batch must not contaminate the next pooled session."""
    from helpers.runs_create import create_run_db

    statements = []
    _, opened = fake_pool(monkeypatch)

    def fail_open(*_args, **_kwargs):
        conn = FakeConnection()
        opened.append(conn)
        return conn

    monkeypatch.setattr(db.pyodbc, "connect", fail_open)
    original_cursor = FakeConnection.cursor

    def cursor_that_fails(self):
        cursor = original_cursor(self)

        def execute(statement, *_args):
            statements.append(statement)
            raise RuntimeError("setup failed")

        cursor.execute = execute
        return cursor

    monkeypatch.setattr(FakeConnection, "cursor", cursor_that_fails)
    with pytest.raises(RuntimeError, match="setup failed"):
        create_run_db("job", "user", "compatibility.v1")
    assert "SET NOCOUNT ON" in statements[0]
    assert "SET NOCOUNT OFF" in statements[0]
    assert opened[0].closes == 1
