"""Request-local HTTP and SQL timings for Jobs."""

from contextvars import ContextVar
from contextlib import contextmanager
from threading import Lock
from functools import wraps
from time import perf_counter
from secrets import token_hex
from uuid import UUID, uuid4
import logging
import re


_current = ContextVar("jobs_request_timing", default=None)
_process_started = perf_counter()
_first_lock = Lock()
_seen_request = False
# Random, process-local correlation tag. It is not an Azure instance ID.
_process_tag = token_hex(4)
_startup_values = {}


def configure_startup(*, azure_ms, routes_ms, register_ms):
    """Store module-load timings after function_app registers its routes."""
    global _startup_values
    _startup_values = {
        "startup_azure": azure_ms,
        "startup_routes": routes_ms,
        "startup_register": register_ms,
        "startup_total": azure_ms + routes_ms + register_ms,
    }


# Fixed names only. Do not put request data in response headers.
STEPS = frozenset({
    "job_row", "legacy_locations", "catalog_load", "catalog_parse",
    "catalog_index", "locations_v2", "location_lookup", "work_time", "serialize",
    "parse", "query_build", "count_query", "page_query",
    "location_hydration", "location_v2_hydration", "location_v2_query",
    "country_lookup", "bulk_parse", "bulk_query", "bulk_format",
})


def set_label(name, value):
    measurements = current()
    allowed = {
        "catalog_cache": ("hit", "miss"),
        "location_display": ("index", "fallback", "stored"),
        "country_lookup_source": ("index", "fallback"),
    }
    if measurements is not None and value in allowed.get(name, ()):
        measurements.labels[name] = value


@contextmanager
def step(name):
    if name not in STEPS:
        raise ValueError("Unknown timing stage")
    measurements = current()
    start = perf_counter()
    try:
        yield
    finally:
        if measurements is not None:
            key = "step_" + name
            measurements.steps[key] = measurements.steps.get(key, 0.0) + (perf_counter() - start) * 1000



class Measurements:
    def __init__(self):
        self.sql_ms = 0.0
        self.dbconn_ms = 0.0
        self.db_open_ms = 0.0
        self.db_validate_ms = 0.0
        self.db_pool_wait_ms = 0.0
        self.connections = []
        self.failure = None
        self.correlation_id = None
        self.sql_count = 0
        self.steps = {}
        self.labels = {}
        self.process_age_ms = 0.0
        self.process_first = False

    def header(self, app_ms):
        parts = [
            f"app;dur={app_ms:.2f}", f"sql;dur={self.sql_ms:.2f}",
            f"dbconn;dur={self.dbconn_ms:.2f}",
            f"db_open;dur={self.db_open_ms:.2f}",
            f"db_validate;dur={self.db_validate_ms:.2f}",
            f"db_pool_wait;dur={self.db_pool_wait_ms:.2f}",
            f"process_age;dur={self.process_age_ms:.2f}",
            f'sql_count;desc="{self.sql_count}"',
            f'process_first;desc="{int(self.process_first)}"',
            f'process_tag;desc="{_process_tag}"',
        ]
        parts.extend(f"{key};dur={value:.2f}" for key, value in _startup_values.items())
        parts.extend(f"{key};dur={value:.2f}" for key, value in self.steps.items())
        parts.extend(f'{key};desc="{value}"' for key, value in self.labels.items())
        return ", ".join(parts)


def current():
    return _current.get()


def _request_correlation_id(args, kwargs):
    req = args[0] if args else kwargs.get("req")
    raw = getattr(req, "headers", {}).get("x-correlation-id") if req else None
    if isinstance(raw, str) and len(raw) == 36:
        try:
            parsed = UUID(raw)
            if str(parsed) == raw.lower() and parsed.version == 4:
                return str(parsed)
        except ValueError:
            pass
    return str(uuid4())


def sqlstate(error):
    args = getattr(error, "args", ())
    state = args[0] if args and isinstance(args[0], str) else None
    return state if state is not None and re.fullmatch(r"[A-Z0-9]{5}", state) else None


def _discard_broken(connection, error):
    state = sqlstate(error)
    if connection is not None and (state and (state.startswith("08") or state in ("HYT00", "HYT01"))):
        connection.invalidate()


def record_db_failure(stage, category, error):
    """Keep a safe SQLSTATE, never an exception message or SQL text."""
    measures = current()
    if measures is None or measures.failure is not None:
        return
    state = sqlstate(error)
    measures.failure = {
        "stage": stage,
        "category": category,
        **({"sqlState": state} if state else {}),
    }


def record_request_failure(stage, category):
    """Record a safe failure with no exception text."""
    measures = current()
    if measures is not None and measures.failure is None:
        measures.failure = {"stage": stage, "category": category}


def _finish_response(response, measure, started, route_name):
    from azure.functions import HttpResponse
    if not isinstance(response, HttpResponse):
        return response
    status = response.status_code
    response.headers["Server-Timing"] = measure.header((perf_counter() - started) * 1000)
    response.headers["x-correlation-id"] = measure.correlation_id
    if status >= 500 and measure.failure:
        failure = measure.failure
        response.headers["x-jobs-failure-stage"] = failure["stage"]
        response.headers["x-jobs-failure-category"] = failure["category"]
        if failure.get("sqlState"):
            response.headers["x-jobs-failure-sqlstate"] = failure["sqlState"]
        # Log a single bounded record. Do not include request or SQL data.
        logging.error(
            "jobs_request_failure route=%s stage=%s category=%s sqlstate=%s correlation_id=%s",
            route_name, failure["stage"], failure["category"],
            failure.get("sqlState", "none"), measure.correlation_id,
        )
    return response


def timed_handler(handler):
    """Measure one invocation and release all SQL leases at request end."""
    @wraps(handler)
    def wrapped(*args, **kwargs):
        global _seen_request
        measure = Measurements()
        measure.correlation_id = _request_correlation_id(args, kwargs)
        measure.process_age_ms = (perf_counter() - _process_started) * 1000
        with _first_lock:
            measure.process_first = not _seen_request
            _seen_request = True
        token = _current.set(measure)
        started = perf_counter()
        try:
            response = handler(*args, **kwargs)
            return _finish_response(response, measure, started, handler.__name__)
        finally:
            # A route can return early and leave a connection open.
            # Never return a transaction to another request without rollback.
            for connection in reversed(measure.connections):
                try:
                    connection.close()
                except Exception:
                    # Return errors do not change a completed HTTP response.
                    logging.error("Jobs SQL connection cleanup failed")
            _current.reset(token)

    return wrapped


class TimedRoutes:
    """Wrap the HTTP route decorators without changing Azure route metadata."""
    def __init__(self, app):
        self.app = app

    def route(self, *args, **kwargs):
        register = self.app.route(*args, **kwargs)

        def decorate(handler):
            return register(timed_handler(handler))
        return decorate

    def __getattr__(self, name):
        return getattr(self.app, name)


class TimedCursor:
    def __init__(self, cursor, measures, connection=None):
        object.__setattr__(self, "_cursor", cursor)
        object.__setattr__(self, "_measures", measures)
        object.__setattr__(self, "_connection", connection)

    def _call(self, name, *args, **kwargs):
        start = perf_counter()
        try:
            result = getattr(self._cursor, name)(*args, **kwargs)
            return self if result is self._cursor else result
        except Exception as exc:
            record_db_failure("db_query", "db_query_failed", exc)
            _discard_broken(self._connection, exc)
            raise
        finally:
            self._measures.sql_ms += (perf_counter() - start) * 1000
            if name in ("execute", "executemany"):
                self._measures.sql_count += 1

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
    def __init__(self, connection, measures):
        object.__setattr__(self, "_connection", connection)
        object.__setattr__(self, "_measures", measures)

    def cursor(self):
        try:
            return TimedCursor(self._connection.cursor(), self._measures, self._connection)
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


def catalog_call(callback):
    """Report hit when this request did not execute the uncached loader."""
    measure = current()
    with step("catalog_load"):
        result = callback()
    if measure is not None and "catalog_cache" not in measure.labels:
        set_label("catalog_cache", "hit")
    return result


def record_elapsed(name, started):
    """Measure an existing long block without moving its control flow."""
    if name not in STEPS:
        raise ValueError("Unknown timing stage")
    measure = current()
    if measure is not None:
        key = "step_" + name
        measure.steps[key] = measure.steps.get(key, 0.0) + (perf_counter() - started) * 1000
