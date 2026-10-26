"""Check Jobs request timing without a database or a Functions host."""

import azure.functions as func
import pytest

from helpers import db
from helpers.timing import Measurements, TimedConnection, TimedCursor, TimedRoutes, current, timed_handler


class FakeCursor:
    description = [("Id",)]

    def __init__(self):
        self.rows = [(1,), (2,)]
        self.fast_executemany = False

    def execute(self, *args):
        return self

    def executemany(self, *args):
        return self

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0]


class FakeConnection:
    timeout = 0

    def __init__(self):
        self.cursor_instance = FakeCursor()

    def cursor(self):
        return self.cursor_instance


def test_handler_keeps_sql_measurements_inside_one_request(monkeypatch):
    monkeypatch.setattr(db.pyodbc, "connect", lambda *args, **kwargs: FakeConnection())

    @timed_handler
    def route():
        connection = db.get_connection()
        connection.timeout = 5
        cursor = connection.cursor()
        assert isinstance(connection, TimedConnection)
        assert isinstance(cursor, TimedCursor)
        assert cursor.execute("SELECT 1") is cursor
        assert cursor.executemany("INSERT", [(1,)]) is cursor
        assert cursor.fetchall() == [(1,), (2,)]
        assert cursor.description == [("Id",)]
        cursor.fast_executemany = True
        assert connection._connection.cursor_instance.fast_executemany is True
        return func.HttpResponse("ok", status_code=200)

    first = route()
    second = route()
    for response in (first, second):
        assert response.status_code == 200
        assert 'sql_count;desc="2"' in response.headers["Server-Timing"]
        assert "dbconn;dur=" in response.headers["Server-Timing"]
        assert "sql;dur=" in response.headers["Server-Timing"]
    assert current() is None


def test_handler_does_not_leak_state_after_failure():
    @timed_handler
    def error():
        assert current() is not None
        raise ValueError("error")

    with pytest.raises(ValueError):
        error()
    assert current() is None


def test_no_database_uses_zero_values():
    @timed_handler
    def route():
        return func.HttpResponse("invalid", status_code=400)

    response = route()
    assert 'sql_count;desc="0"' in response.headers["Server-Timing"]
    assert "app;dur=" in response.headers["Server-Timing"]


def test_cursor_count_increases_on_failed_execution():
    class FailingCursor(FakeCursor):
        def execute(self, *args):
            raise RuntimeError("SQL failed")

    measurement = Measurements()
    cursor = TimedCursor(FailingCursor(), measurement)
    with pytest.raises(RuntimeError):
        cursor.execute("bad")
    assert measurement.sql_count == 1


def test_route_facade_keeps_registration_metadata():
    class App:
        def route(self, **options):
            assert options == {"route": "jobs", "methods": ["GET"]}
            def decorate(callback):
                self.callback = callback
                return callback
            return decorate

    app = App()
    wrapped = TimedRoutes(app)

    @wrapped.route(route="jobs", methods=["GET"])
    def jobs():
        return func.HttpResponse("ok")

    assert app.callback is jobs
    assert "app;dur=" in app.callback().headers["Server-Timing"]
