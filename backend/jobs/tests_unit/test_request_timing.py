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


def test_startup_probe_keeps_process_values_outside_handler_work(monkeypatch):
    import helpers.timing as timing

    # The probe runs once during module registration, before requests start.
    original = timing._startup_values
    try:
        timing.configure_startup(azure_ms=12.5, routes_ms=44.5, register_ms=3)

        @timed_handler
        def route():
            return func.HttpResponse('ok')

        first = route().headers['Server-Timing']
        second = route().headers['Server-Timing']
        for header in (first, second):
            assert 'startup_azure;dur=12.50' in header
            assert 'startup_routes;dur=44.50' in header
            assert 'startup_register;dur=3.00' in header
            assert 'startup_total;dur=60.00' in header
            assert f'process_tag;desc="{timing._process_tag}"' in header
        assert len(timing._process_tag) == 8
        assert first.split('process_tag;desc="')[1][:8] == second.split('process_tag;desc="')[1][:8]
    finally:
        timing._startup_values = original


def test_function_app_marks_import_and_route_registration(monkeypatch):
    import importlib.util
    import sys
    import types
    from pathlib import Path
    import helpers.timing as timing

    class FakeFunctionsApp:
        def route(self, **_options):
            return lambda handler: handler

    # Avoid importing production routes in this isolated registration test.
    routes = types.ModuleType("routes")
    registrations = []
    routes.register_all = lambda _app: registrations.append(True)
    monkeypatch.setitem(sys.modules, "routes", routes)
    monkeypatch.setattr(func, "FunctionApp", FakeFunctionsApp, raising=False)
    monkeypatch.setattr(func, "HttpRequest", object, raising=False)
    recorded = []
    monkeypatch.setattr(timing, "configure_startup", lambda **kw: recorded.append(kw))
    path = Path(__file__).resolve().parents[1] / "function_app.py"
    spec = importlib.util.spec_from_file_location("jobs_startup_probe_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert len(registrations) == 1
    assert len(recorded) == 1
    assert set(recorded[0]) == {"azure_ms", "routes_ms", "register_ms"}
    assert all(value >= 0 for value in recorded[0].values())
