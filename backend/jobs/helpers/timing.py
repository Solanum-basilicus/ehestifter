"""Request-local HTTP and SQL timings for Jobs."""

from contextvars import ContextVar
from functools import wraps
from time import perf_counter

from azure.functions import HttpResponse


_current = ContextVar("jobs_request_timing", default=None)


class Measurements:
    def __init__(self):
        self.sql_ms = 0.0
        self.dbconn_ms = 0.0
        self.sql_count = 0

    def header(self, app_ms):
        return (
            f"app;dur={app_ms:.2f}, sql;dur={self.sql_ms:.2f}, "
            f"dbconn;dur={self.dbconn_ms:.2f}, sql_count;desc=\"{self.sql_count}\""
        )


def current():
    return _current.get()


def timed_handler(handler):
    """Measure one invocation. Do not share measurements between requests."""
    @wraps(handler)
    def wrapped(*args, **kwargs):
        measure = Measurements()
        token = _current.set(measure)
        start = perf_counter()
        try:
            response = handler(*args, **kwargs)
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
