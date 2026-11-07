"""Bounded per-request timing data for Enrichers HTTP endpoints."""

from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
from threading import Lock
from time import perf_counter
from uuid import UUID, uuid4
import logging
import re

_current = ContextVar("enrichers_http_timing", default=None)
_started = perf_counter()
_seen = False
_lock = Lock()

STAGES = frozenset({
    "run_create", "run_readback", "analytics", "job_snapshot", "cv_snapshot",
    "snapshot_validate", "blob_upload", "snapshot_path_update", "gateway_dispatch",
    "mark_queued",
})
# Gateway metadata is copied only from this set of fields.
GATEWAY_NUMBERS = frozenset({"app", "process_age", "step_servicebus_dispatch", "step_servicebus_client", "step_servicebus_sender", "step_servicebus_send"})
GATEWAY_LABELS = frozenset({"process_first"})
# Only the Users CV-snapshot call contributes these fields.
USERS_NUMBERS = frozenset({
    "app", "dbconn", "sql", "process_age", "step_cv_lookup",
    "step_blob_client", "step_blob_download", "step_serialize",
})
USERS_LABELS = frozenset({"sql_count", "process_first"})


class Measurements:
    def __init__(self):
        self.values = {}
        self.labels = {}
        self.failed_stage = None
        self.connections = []
        self.failure = None
        self.correlation_id = None
        self.sql_count = 0
        self.pool_leases = {"hit": 0, "new": 0, "replaced": 0, "disabled": 0}

    def header(self, elapsed):
        values = {"app": elapsed, **self.values}
        labels = {
            "sql_count": str(self.sql_count),
            **{f"db_pool_{name}": str(value) for name, value in self.pool_leases.items()},
            **self.labels,
        }
        return ", ".join(
            [f"{name};dur={ms:.2f}" for name, ms in values.items()]
            + [f'{name};desc="{label}"' for name, label in labels.items()]
        )


def current():
    return _current.get()


def failed_stage(default):
    measure = current()
    return measure.failed_stage if measure is not None and measure.failed_stage else default


def clear_failed_stage():
    measure = current()
    if measure is not None:
        measure.failed_stage = None


@contextmanager
def step(name):
    if name not in STAGES:
        raise ValueError("Unknown timing stage")
    measure = current()
    start = perf_counter()
    try:
        yield
    except Exception:
        if measure is not None and measure.failed_stage is None:
            measure.failed_stage = name
        raise
    finally:
        if measure is not None:
            key = "step_" + name
            measure.values[key] = measure.values.get(key, 0) + (perf_counter() - start) * 1000


def gateway_response_timing(header, http_ms):
    """Copy allowlisted gateway fields and calculate HTTP time outside its handler."""
    from helpers.timing_header import parse_header

    measure = current()
    if measure is None:
        return
    measure.values["gateway_http"] = http_ms
    numbers, labels = parse_header(header, GATEWAY_NUMBERS, GATEWAY_LABELS)
    for name, value in numbers.items():
        measure.values["gateway_" + name] = value
    for name, value in labels.items():
        measure.labels["gateway_" + name] = value
    if "app" in numbers:
        measure.values["gateway_unattributed"] = max(0, http_ms - numbers["app"])


def users_response_timing(header, http_ms):
    """Keep the Users HTTP attempt even without a returned timing header."""
    from helpers.timing_header import parse_header

    measure = current()
    if measure is None:
        return
    measure.values["users_http"] = http_ms
    numbers, labels = parse_header(header, USERS_NUMBERS, USERS_LABELS)
    for name, value in numbers.items():
        measure.values["users_" + name] = value
    for name, value in labels.items():
        measure.labels["users_" + name] = value
    if "app" in numbers:
        measure.values["users_unattributed"] = max(0, http_ms - numbers["app"])


def _request_correlation_id(args, kwargs):
    request = args[0] if args else kwargs.get("req")
    raw = getattr(request, "headers", {}).get("x-correlation-id") if request else None
    if isinstance(raw, str) and len(raw) == 36:
        try:
            parsed = UUID(raw)
            if str(parsed) == raw.lower():
                return str(parsed)
        except ValueError:
            pass
    return str(uuid4())


def sqlstate(error):
    """Read a SQLSTATE only. Do not read the SQL error message."""
    args = getattr(error, "args", ())
    state = args[0] if args and isinstance(args[0], str) else None
    return state if state is not None and re.fullmatch(r"[A-Z0-9]{5}", state) else None


def _discard_broken(connection, error):
    state = sqlstate(error)
    if connection is not None and state and (
        state.startswith("08") or state in ("HYT00", "HYT01")
    ):
        connection.invalidate()


def record_db_failure(stage, category, error):
    """Keep fixed diagnostic fields, not query text or error messages."""
    measure = current()
    if measure is not None and measure.failure is None:
        state = sqlstate(error)
        measure.failure = {
            "stage": stage, "category": category,
            **({"sqlState": state} if state else {}),
        }


def timed_handler(handler):
    @wraps(handler)
    def wrapped(*args, **kwargs):
        global _seen
        measure = Measurements()
        measure.values["process_age"] = (perf_counter() - _started) * 1000
        measure.correlation_id = _request_correlation_id(args, kwargs)
        with _lock:
            measure.labels["process_first"] = str(int(not _seen))
            _seen = True
        token = _current.set(measure)
        start = perf_counter()
        try:
            response = handler(*args, **kwargs)
        finally:
            # A route can exit before closing its SQL lease.
            for connection in reversed(measure.connections):
                try:
                    connection.close()
                except Exception:
                    logging.error("enrichers_sql_cleanup_failure")
            _current.reset(token)

        from azure.functions import HttpResponse
        if isinstance(response, HttpResponse):
            response.headers["Server-Timing"] = measure.header((perf_counter() - start) * 1000)
            response.headers["x-correlation-id"] = measure.correlation_id
            if response.status_code >= 500 and measure.failure:
                failure = measure.failure
                # A run creation failure already has a stage-specific record.
                if "x-enrichment-failure-stage" not in response.headers:
                    response.headers["x-enrichment-failure-stage"] = failure["stage"]
                    response.headers["x-enrichment-failure-category"] = failure["category"]
                    if failure.get("sqlState"):
                        response.headers["x-enrichment-failure-sqlstate"] = failure["sqlState"]
                    logging.error(
                        "enrichers_sql_failure stage=%s category=%s sqlState=%s corr=%s",
                        failure["stage"], failure["category"],
                        failure.get("sqlState", "none"), measure.correlation_id,
                    )
        return response
    return wrapped


class TimedCursor:
    """Measure SQL work and discard a broken pooled connection."""

    def __init__(self, cursor, measure, connection):
        object.__setattr__(self, "_cursor", cursor)
        object.__setattr__(self, "_measure", measure)
        object.__setattr__(self, "_connection", connection)

    def _call(self, method, *args, **kwargs):
        started = perf_counter()
        try:
            result = getattr(self._cursor, method)(*args, **kwargs)
            return self if result is self._cursor else result
        except Exception as exc:
            record_db_failure("db_query", "db_query_failed", exc)
            _discard_broken(self._connection, exc)
            raise
        finally:
            if self._measure is not None:
                self._measure.values["sql"] = self._measure.values.get("sql", 0) + (perf_counter() - started) * 1000
                if method in ("execute", "executemany"):
                    self._measure.sql_count += 1

    def execute(self, *args, **kwargs):
        return self._call("execute", *args, **kwargs)

    def executemany(self, *args, **kwargs):
        return self._call("executemany", *args, **kwargs)

    def fetchone(self, *args, **kwargs):
        return self._call("fetchone", *args, **kwargs)

    def fetchall(self, *args, **kwargs):
        return self._call("fetchall", *args, **kwargs)

    def fetchmany(self, *args, **kwargs):
        return self._call("fetchmany", *args, **kwargs)

    def __iter__(self):
        return self

    def __next__(self):
        return self._call("__next__")

    def __enter__(self):
        self._cursor.__enter__()
        return self

    def __exit__(self, *args):
        return self._cursor.__exit__(*args)

    def __getattr__(self, name):
        return getattr(self._cursor, name)

    def __setattr__(self, name, value):
        setattr(self._cursor, name, value)


class TimedConnection:
    """Keep the route SQL API and add safe failure details."""

    def __init__(self, connection, measure):
        object.__setattr__(self, "_connection", connection)
        object.__setattr__(self, "_measure", measure)

    def cursor(self):
        try:
            return TimedCursor(self._connection.cursor(), self._measure, self._connection)
        except Exception as exc:
            record_db_failure("db_query", "db_query_failed", exc)
            _discard_broken(self._connection, exc)
            raise

    def commit(self):
        try:
            return self._connection.commit()
        except Exception as exc:
            record_db_failure("db_transaction", "db_transaction_failed", exc)
            self._connection.invalidate()
            raise

    def rollback(self):
        try:
            return self._connection.rollback()
        except Exception as exc:
            record_db_failure("db_transaction", "db_transaction_failed", exc)
            self._connection.invalidate()
            raise

    def __enter__(self):
        self._connection.__enter__()
        return self

    def __exit__(self, *args):
        return self._connection.__exit__(*args)

    def __getattr__(self, name):
        return getattr(self._connection, name)

    def __setattr__(self, name, value):
        setattr(self._connection, name, value)


class TimedRoutes:
    def __init__(self, app):
        self.app = app

    def route(self, *args, **kwargs):
        register = self.app.route(*args, **kwargs)
        def decorate(handler):
            return register(timed_handler(handler))
        return decorate

    def __getattr__(self, name):
        return getattr(self.app, name)
