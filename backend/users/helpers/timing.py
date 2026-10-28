"""Request-local timing for Users. Only fixed metric names leave the service."""

from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
from threading import Lock
from time import perf_counter

_current = ContextVar("users_request_timing", default=None)
_process_started = perf_counter()
_first_lock = Lock()
_seen_request = False

STEPS = frozenset({
    "cv_lookup", "blob_client", "blob_download", "blob_upload",
    "cv_convert", "discovery_query", "profile_normalize",
    "cv_batch_download", "readiness", "analytics", "serialize",
    "user_lookup",
})


class Measurements:
    def __init__(self):
        self.dbconn_ms = 0.0
        self.sql_ms = 0.0
        self.sql_count = 0
        self.steps = {}
        self.process_age_ms = 0.0
        self.process_first = False

    def header(self, app_ms):
        parts = [
            f"app;dur={app_ms:.2f}",
            f"dbconn;dur={self.dbconn_ms:.2f}",
            f"sql;dur={self.sql_ms:.2f}",
            f'sql_count;desc="{self.sql_count}"',
            f"process_age;dur={self.process_age_ms:.2f}",
            f'process_first;desc="{int(self.process_first)}"',
        ]
        parts.extend(f"{name};dur={ms:.2f}" for name, ms in self.steps.items())
        return ", ".join(parts)


def current():
    return _current.get()


@contextmanager
def step(name):
    if name not in STEPS:
        raise ValueError("Unknown timing stage")
    measure = current()
    started = perf_counter() if measure is not None else None
    try:
        yield
    finally:
        if measure is not None:
            key = "step_" + name
            measure.steps[key] = measure.steps.get(key, 0.0) + (perf_counter() - started) * 1000


def timed_handler(handler):
    @wraps(handler)
    def wrapped(*args, **kwargs):
        global _seen_request
        measure = Measurements()
        measure.process_age_ms = (perf_counter() - _process_started) * 1000
        with _first_lock:
            measure.process_first = not _seen_request
            _seen_request = True
        token = _current.set(measure)
        started = perf_counter()
        try:
            response = handler(*args, **kwargs)
            from azure.functions import HttpResponse
            if isinstance(response, HttpResponse):
                response.headers["Server-Timing"] = measure.header((perf_counter() - started) * 1000)
            return response
        finally:
            _current.reset(token)
    return wrapped


class TimedRoutes:
    """Keep the Azure Functions route registration contract."""
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
    def __init__(self, cursor, measure):
        object.__setattr__(self, "_cursor", cursor)
        object.__setattr__(self, "_measure", measure)

    def _call(self, name, *args, **kwargs):
        started = perf_counter()
        try:
            result = getattr(self._cursor, name)(*args, **kwargs)
            return self if result is self._cursor else result
        finally:
            self._measure.sql_ms += (perf_counter() - started) * 1000
            if name in ("execute", "executemany"):
                self._measure.sql_count += 1

    def execute(self, *args, **kwargs):
        return self._call("execute", *args, **kwargs)

    def executemany(self, *args, **kwargs):
        return self._call("executemany", *args, **kwargs)

    def fetchone(self, *args, **kwargs):
        return self._call("fetchone", *args, **kwargs)

    def fetchmany(self, *args, **kwargs):
        return self._call("fetchmany", *args, **kwargs)

    def fetchall(self, *args, **kwargs):
        return self._call("fetchall", *args, **kwargs)

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
    def __init__(self, connection, measure):
        object.__setattr__(self, "_connection", connection)
        object.__setattr__(self, "_measure", measure)

    def cursor(self):
        return TimedCursor(self._connection.cursor(), self._measure)

    def __enter__(self):
        self._connection.__enter__()
        return self

    def __exit__(self, *args):
        return self._connection.__exit__(*args)

    def __getattr__(self, name):
        return getattr(self._connection, name)

    def __setattr__(self, name, value):
        setattr(self._connection, name, value)
