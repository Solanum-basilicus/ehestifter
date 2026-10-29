"""Request-local HTTP and SQL timings for Jobs."""

from contextvars import ContextVar
from contextlib import contextmanager
from threading import Lock
from functools import wraps
from time import perf_counter


_current = ContextVar("jobs_request_timing", default=None)
_process_started = perf_counter()
_first_lock = Lock()
_seen_request = False

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
        self.sql_count = 0
        self.steps = {}
        self.labels = {}
        self.process_age_ms = 0.0
        self.process_first = False

    def header(self, app_ms):
        parts = [
            f"app;dur={app_ms:.2f}", f"sql;dur={self.sql_ms:.2f}",
            f"dbconn;dur={self.dbconn_ms:.2f}",
            f"process_age;dur={self.process_age_ms:.2f}",
            f'sql_count;desc="{self.sql_count}"',
            f'process_first;desc="{int(self.process_first)}"',
        ]
        parts.extend(f"{key};dur={value:.2f}" for key, value in self.steps.items())
        parts.extend(f'{key};desc="{value}"' for key, value in self.labels.items())
        return ", ".join(parts)


def current():
    return _current.get()


def timed_handler(handler):
    """Measure one invocation. Do not share measurements between requests."""
    @wraps(handler)
    def wrapped(*args, **kwargs):
        global _seen_request
        measure = Measurements()
        measure.process_age_ms = (perf_counter() - _process_started) * 1000
        with _first_lock:
            measure.process_first = not _seen_request
            _seen_request = True
        token = _current.set(measure)
        start = perf_counter()
        try:
            response = handler(*args, **kwargs)
            from azure.functions import HttpResponse
            if isinstance(response, HttpResponse):
                response.headers["Server-Timing"] = measure.header((perf_counter() - start) * 1000)
            return response
        finally:
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
    def __init__(self, cursor, measures):
        object.__setattr__(self, "_cursor", cursor)
        object.__setattr__(self, "_measures", measures)

    def _call(self, name, *args, **kwargs):
        start = perf_counter()
        try:
            result = getattr(self._cursor, name)(*args, **kwargs)
            return self if result is self._cursor else result
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
        return TimedCursor(self._connection.cursor(), self._measures)

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
