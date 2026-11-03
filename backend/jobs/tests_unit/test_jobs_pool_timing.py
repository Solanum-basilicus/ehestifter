"""Check Jobs request-level SQL reuse and safe diagnostics."""

import logging

import azure.functions as func
import pytest

from helpers import db
from helpers.sql_pool import ConnectionPool
from helpers.timing import timed_handler, current


class FakeCursor:
    def __init__(self, failing=False):
        self.failing = failing

    def execute(self, _sql):
        if self.failing:
            raise db.pyodbc.OperationalError('08S01', 'confidential SQL details')
        return self

    def fetchone(self):
        return (1,)

    def close(self):
        pass


class FakeConnection:
    def __init__(self, *, failing_query=False):
        self.failing_query = failing_query
        self.timeout = 0
        self.closed = 0
        self.rollbacks = 0

    def cursor(self):
        return FakeCursor(failing=self.failing_query)

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closed += 1


class Request:
    def __init__(self, correlation_id=None):
        self.headers = {'x-correlation-id': correlation_id} if correlation_id else {}


def test_request_cleanup_reuses_connection_for_next_request(monkeypatch):
    made = []
    monkeypatch.setattr(db, 'POOL_ENABLED', True)
    monkeypatch.setattr(db, '_pool', ConnectionPool(max_size=1))

    def connect(*_args, **_kwargs):
        conn = FakeConnection()
        made.append(conn)
        return conn

    monkeypatch.setattr(db.pyodbc, 'connect', connect)

    @timed_handler
    def request(_req):
        connection = db.get_connection()
        connection.cursor().execute('SELECT 1').fetchone()
        # No explicit close: the wrapper must return the lease.
        return func.HttpResponse('ok', status_code=200)

    first = request(Request())
    second = request(Request())
    assert len(made) == 1
    assert made[0].rollbacks == 2
    assert made[0].closed == 0
    assert 'db_pool;desc="new"' in first.headers['Server-Timing']
    assert 'db_pool;desc="hit"' in second.headers['Server-Timing']
    assert 'db_open;dur=' in first.headers['Server-Timing']
    assert 'db_pool_wait;dur=' in second.headers['Server-Timing']
    assert current() is None


def test_explicit_close_does_not_release_twice(monkeypatch):
    physical = FakeConnection()
    monkeypatch.setattr(db, 'POOL_ENABLED', True)
    monkeypatch.setattr(db, '_pool', ConnectionPool(max_size=1))
    monkeypatch.setattr(db.pyodbc, 'connect', lambda *_a, **_kw: physical)

    @timed_handler
    def request(_req):
        db.get_connection().close()
        return func.HttpResponse('ok')

    request(Request())
    assert physical.rollbacks == 1


def test_connect_failure_exposes_safe_fields_only(monkeypatch, caplog):
    monkeypatch.setattr(db, 'POOL_ENABLED', True)
    monkeypatch.setattr(db, '_pool', ConnectionPool(max_size=1))

    def fail(*_args, **_kwargs):
        raise db.pyodbc.OperationalError('HYT00', 'SECRET credentials=abc')

    monkeypatch.setattr(db.pyodbc, 'connect', fail)

    @timed_handler
    def request(_req):
        try:
            db.get_connection()
        except Exception as exc:
            return func.HttpResponse(str(exc), status_code=500)
        raise AssertionError('must fail')

    with caplog.at_level(logging.ERROR):
        response = request(Request('untrusted text;desc="bad"'))
    assert response.status_code == 500
    assert response.headers['x-jobs-failure-stage'] == 'db_acquire'
    assert response.headers['x-jobs-failure-category'] == 'db_connection_operational'
    assert response.headers['x-jobs-failure-sqlstate'] == 'HYT00'
    assert response.headers['x-correlation-id'] != 'untrusted text;desc="bad"'
    assert 'SECRET' not in str(response.get_body()) + caplog.text
    assert 'credentials' not in str(response.get_body()) + caplog.text
    assert caplog.text.count('jobs_request_failure') == 1


def test_query_failure_exposes_stage_without_sql_text(monkeypatch, caplog):
    monkeypatch.setattr(db, 'POOL_ENABLED', True)
    monkeypatch.setattr(db, '_pool', ConnectionPool(max_size=1))
    physical = FakeConnection(failing_query=True)
    monkeypatch.setattr(db.pyodbc, 'connect', lambda *_a, **_kw: physical)

    @timed_handler
    def request(_req):
        try:
            db.get_connection().cursor().execute('secret query')
        except Exception:
            return func.HttpResponse('Server error', status_code=500)
        raise AssertionError('must fail')

    with caplog.at_level(logging.ERROR):
        response = request(Request())
    assert response.headers['x-jobs-failure-stage'] == 'db_query'
    assert response.headers['x-jobs-failure-category'] == 'db_query_failed'
    assert response.headers['x-jobs-failure-sqlstate'] == '08S01'
    assert 'secret' not in caplog.text
    # A transport SQLSTATE must not return a broken socket to the idle pool.
    assert physical.closed == 1
    assert physical.rollbacks == 0


def test_healthy_request_emits_no_failure_trace(monkeypatch, caplog):
    monkeypatch.setattr(db, 'POOL_ENABLED', True)
    monkeypatch.setattr(db, '_pool', ConnectionPool(max_size=1))
    monkeypatch.setattr(db.pyodbc, 'connect', lambda *_a, **_kw: FakeConnection())

    @timed_handler
    def request(_req):
        db.get_connection()
        return func.HttpResponse('ok')

    with caplog.at_level(logging.DEBUG):
        response = request(Request())
    assert response.status_code == 200
    assert 'x-jobs-failure-stage' not in response.headers
    assert 'jobs_request_failure' not in caplog.text


def test_disabled_pool_closes_one_connection_once(monkeypatch, caplog):
    physical = FakeConnection()
    monkeypatch.setattr(db, 'POOL_ENABLED', False)
    monkeypatch.setattr(db.pyodbc, 'connect', lambda *_a, **_kw: physical)

    @timed_handler
    def request(_req):
        conn = db.get_connection()
        conn.close()
        return func.HttpResponse('ok')

    with caplog.at_level(logging.ERROR):
        response = request(Request())
    assert physical.closed == 1
    assert 'db_pool;desc="disabled"' in response.headers['Server-Timing']
    assert 'Jobs SQL connection cleanup failed' not in caplog.text


def test_validation_sets_timeout_before_new_cursor():
    class Cursor:
        __slots__ = ('timeout_at_creation',)

        def __init__(self, timeout):
            self.timeout_at_creation = timeout

        def execute(self, sql):
            assert sql == 'SELECT 1'
            return self

        def fetchone(self):
            return (1,)

        def close(self):
            pass

    class Connection(FakeConnection):
        def cursor(self):
            self.last_cursor = Cursor(self.timeout)
            return self.last_cursor

    connection = Connection()
    connection.timeout = 5
    db._validate(connection)
    assert connection.last_cursor.timeout_at_creation == 2
    assert connection.timeout == 5
    assert connection.rollbacks == 1


def test_request_handler_records_safe_non_sql_failure(caplog):
    from helpers.timing import record_request_failure

    @timed_handler
    def request(_req):
        record_request_failure('request_handler', 'internal_error')
        return func.HttpResponse('Server error', status_code=500)

    with caplog.at_level(logging.ERROR):
        response = request(Request())
    assert response.headers['x-jobs-failure-stage'] == 'request_handler'
    assert response.headers['x-jobs-failure-category'] == 'internal_error'
    assert caplog.text.count('jobs_request_failure') == 1
