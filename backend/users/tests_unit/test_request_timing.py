"""Users timing tests. These tests do not call a deployed service."""

import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace

import azure.functions as func
import pytest

from helpers.timing import (
    TimedConnection, TimedRoutes, current, step, timed_handler, Measurements,
)


class Cursor:
    def __init__(self, rows=()):
        self.rows = list(rows)
        self.description = ("value",)
        self.fail = False

    def execute(self, *args):
        if self.fail:
            raise RuntimeError("db unavailable")
        return self

    def executemany(self, *args):
        return self

    def fetchone(self):
        return self.rows.pop(0) if self.rows else None

    def fetchall(self):
        rows, self.rows = self.rows, []
        return rows

    def fetchmany(self, size=1):
        rows, self.rows = self.rows[:size], self.rows[size:]
        return rows

    def __iter__(self):
        return self

    def __next__(self):
        if not self.rows:
            raise StopIteration
        return self.rows.pop(0)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class Connection:
    def __init__(self, rows=()):
        self.cur = Cursor(rows)
        self.autocommit = True
        self.committed = False

    def cursor(self):
        return self.cur

    def commit(self):
        self.committed = True

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_sql_cursor_preserves_chaining_fetch_iteration_and_attributes():
    measure = Measurements()
    raw = Connection([("a",), ("b",), ("c",)])
    conn = TimedConnection(raw, measure)
    conn.autocommit = False
    assert raw.autocommit is False
    with conn as active:
        with active.cursor() as cursor:
            assert cursor.execute("SELECT").description == raw.cur.description
            assert cursor.fetchone() == ("a",)
            assert cursor.fetchmany() == [("b",)]
            assert list(cursor) == [("c",)]
            cursor.executemany("INSERT", [])
        active.commit()
    assert raw.committed
    assert measure.sql_count == 2
    assert measure.sql_ms >= 0


def test_sql_error_is_measured_and_not_changed():
    measure = Measurements()
    conn = TimedConnection(Connection(), measure)
    conn.cursor()._cursor.fail = True
    with pytest.raises(RuntimeError, match="db unavailable"):
        conn.cursor().execute("SELECT")
    assert measure.sql_count == 1
    assert measure.sql_ms >= 0


def test_success_early_return_exception_and_no_sql_are_isolated():
    @timed_handler
    def route(kind):
        if kind == "fail":
            with step("cv_lookup"):
                raise RuntimeError("expected")
        if kind == "ok":
            with step("cv_lookup"):
                pass
        return func.HttpResponse("ok" if kind == "ok" else "missing", status_code=200 if kind == "ok" else 404)

    success = route("ok")
    missing = route("missing")
    assert "step_cv_lookup;dur=" in success.headers["Server-Timing"]
    assert "step_cv_lookup" not in missing.headers["Server-Timing"]
    assert 'sql_count;desc="0"' in missing.headers["Server-Timing"]
    with pytest.raises(RuntimeError):
        route("fail")
    assert current() is None


def test_first_request_indicator_and_parallel_request_isolation(monkeypatch):
    import helpers.timing as timing
    monkeypatch.setattr(timing, "_seen_request", False)
    barrier = Barrier(2)

    @timed_handler
    def route(stage_name):
        barrier.wait(timeout=5)
        with step(stage_name):
            pass
        return func.HttpResponse("ok")

    with ThreadPoolExecutor(max_workers=2) as pool:
        a = pool.submit(route, "cv_lookup")
        b = pool.submit(route, "readiness")
        left = a.result(timeout=5).headers["Server-Timing"]
        right = b.result(timeout=5).headers["Server-Timing"]
    assert 'process_first;desc="1"' in left + right
    assert sum('process_first;desc="1"' in value for value in (left, right)) == 1
    assert "step_readiness" not in left
    assert "step_cv_lookup" not in right
    assert current() is None


def test_route_adapter_keeps_registration_metadata():
    registered = []

    class App:
        def route(self, *args, **kwargs):
            def register(handler):
                registered.append((args, kwargs, handler))
                return handler
            return register

    app = TimedRoutes(App())

    @app.route(route="users/demo", methods=["GET"])
    def handler(req):
        return func.HttpResponse("ok")

    assert registered[0][1] == {"route": "users/demo", "methods": ["GET"]}
    assert "app;dur=" in registered[0][2](None).headers["Server-Timing"]


def test_cv_snapshot_route_has_safe_details_and_preserves_body(monkeypatch):
    from routes import internal_cv_snapshot
    handlers = {}

    class App:
        def route(self, **kwargs):
            def register(handler):
                handlers[kwargs["route"]] = handler
                return handler
            return register

    raw = Connection([("secret/path", "version", None)])
    monkeypatch.setattr(internal_cv_snapshot, "get_connection", lambda: raw)
    monkeypatch.setattr(internal_cv_snapshot, "download_text", lambda path: "private CV")
    internal_cv_snapshot.register(TimedRoutes(App()))
    route = handlers["users/internal/{userId}/cv-snapshot"]
    uid = "148bdc7a-23df-402c-860d-635fbfd04e13"
    result = route(SimpleNamespace(route_params={"userId": uid}))
    assert result.status_code == 200
    body = json.loads(result.get_body())
    assert body["CVPlainText"] == "private CV"
    assert body["CVTextBlobPath"] == "secret/path"
    header = result.headers["Server-Timing"]
    assert "step_cv_lookup" in header and "step_serialize" in header
    assert "secret" not in header and "private" not in header and uid not in header
    invalid = route(SimpleNamespace(route_params={}))
    assert invalid.status_code == 400
    assert "app;dur=" in invalid.headers["Server-Timing"]


def test_blob_download_and_missing_result_are_measured(monkeypatch):
    import sys
    import types
    from helpers import blob_storage

    class Missing(Exception):
        pass

    exceptions = types.ModuleType("azure.core.exceptions")
    exceptions.ResourceNotFoundError = Missing
    monkeypatch.setitem(sys.modules, "azure.core.exceptions", exceptions)

    class Blob:
        def __init__(self, error=False):
            self.error = error

        def download_blob(self):
            if self.error:
                raise Missing()
            return SimpleNamespace(readall=lambda: b"abc")

    monkeypatch.setattr(blob_storage, "_get_blob_client", lambda path: Blob(error=path == "missing"))

    @timed_handler
    def route():
        assert blob_storage.download_text("ok") == "abc"
        assert blob_storage.download_bytes("missing") is None
        return func.HttpResponse("ok")

    assert "step_blob_download;dur=" in route().headers["Server-Timing"]


def test_db_connection_success_and_failure_are_measured(monkeypatch):
    from helpers import db

    original = Connection()
    monkeypatch.setattr(db.pyodbc, "connect", lambda *args, **kwargs: original)

    @timed_handler
    def connected():
        conn = db.get_connection()
        assert isinstance(conn, TimedConnection)
        assert conn._connection is original
        return func.HttpResponse("ok")

    header = connected().headers["Server-Timing"]
    assert "dbconn;dur=" in header

    def fail(*args, **kwargs):
        raise db.pyodbc.OperationalError("private credentials")

    monkeypatch.setattr(db.pyodbc, "connect", fail)

    @timed_handler
    def failing():
        with pytest.raises(Exception, match="invalid credentials or timeout"):
            db.get_connection()
        return func.HttpResponse("failed", status_code=500)

    header = failing().headers["Server-Timing"]
    assert "dbconn;dur=" in header
    assert "private" not in header


def test_blob_client_setup_and_upload_failure_have_safe_stages(monkeypatch):
    import sys
    import types
    from helpers import blob_storage

    identity = types.ModuleType("azure.identity")
    identity.DefaultAzureCredential = lambda: object()
    storage = types.ModuleType("azure.storage.blob")

    class BlobClient:
        def upload_blob(self, *args, **kwargs):
            raise RuntimeError("storage failed")

    class ServiceClient:
        def __init__(self, **kwargs):
            pass

        def get_blob_client(self, **kwargs):
            return BlobClient()

    storage.BlobServiceClient = ServiceClient
    storage.ContentSettings = lambda **kwargs: object()
    monkeypatch.setitem(sys.modules, "azure.identity", identity)
    monkeypatch.setitem(sys.modules, "azure.storage.blob", storage)
    monkeypatch.setenv("CV_STORAGE__blobServiceUri", "https://example.blob.core.windows.net")

    @timed_handler
    def route():
        with pytest.raises(RuntimeError, match="storage failed"):
            blob_storage.upload_text("sensitive/path", "secret CV")
        return func.HttpResponse("failed", status_code=500)

    header = route().headers["Server-Timing"]
    assert "step_blob_client;dur=" in header
    assert "step_blob_upload;dur=" in header
    assert "secret" not in header and "sensitive" not in header
