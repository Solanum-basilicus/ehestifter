"""Request-local timing for Azure Gateway and Cloud Run Gateway."""

from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
from threading import Lock
from time import perf_counter

_current = ContextVar("gateway_http_timing", default=None)
_started = perf_counter()
_seen = False
_lock = Lock()
STAGES = frozenset({"servicebus_dispatch", "servicebus_client", "servicebus_sender", "servicebus_send"})


class Measurements:
    def __init__(self):
        self.values = {"process_age": (perf_counter() - _started) * 1000}
        self.labels = {}

    def header(self, elapsed):
        return ", ".join(
            [f"app;dur={elapsed:.2f}"]
            + [f"{name};dur={ms:.2f}" for name, ms in self.values.items()]
            + [f'{name};desc="{value}"' for name, value in self.labels.items()]
        )


def begin():
    global _seen
    measure = Measurements()
    with _lock:
        measure.labels["process_first"] = str(int(not _seen))
        _seen = True
    token = _current.set(measure)
    return token, measure, perf_counter()


def end(token):
    _current.reset(token)


@contextmanager
def step(name):
    if name not in STAGES:
        raise ValueError("Unknown timing stage")
    measure = _current.get()
    start = perf_counter()
    try:
        yield
    finally:
        if measure is not None:
            key = "step_" + name
            measure.values[key] = measure.values.get(key, 0) + (perf_counter() - start) * 1000


def timed_handler(handler):
    @wraps(handler)
    def wrapped(*args, **kwargs):
        from azure.functions import HttpResponse
        token, measure, start = begin()
        try:
            response = handler(*args, **kwargs)
            if isinstance(response, HttpResponse):
                response.headers["Server-Timing"] = measure.header((perf_counter() - start) * 1000)
            return response
        finally:
            end(token)
    return wrapped


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
