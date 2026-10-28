"""Bounded per-request timing data for Enrichers HTTP endpoints."""

from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
from threading import Lock
from time import perf_counter

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


class Measurements:
    def __init__(self):
        self.values = {}
        self.labels = {}

    def header(self, elapsed):
        values = {"app": elapsed, **self.values}
        return ", ".join(
            [f"{name};dur={ms:.2f}" for name, ms in values.items()]
            + [f'{name};desc="{label}"' for name, label in self.labels.items()]
        )


def current():
    return _current.get()


@contextmanager
def step(name):
    if name not in STAGES:
        raise ValueError("Unknown timing stage")
    measure = current()
    start = perf_counter()
    try:
        yield
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


def timed_handler(handler):
    @wraps(handler)
    def wrapped(*args, **kwargs):
        global _seen
        measure = Measurements()
        measure.values["process_age"] = (perf_counter() - _started) * 1000
        with _lock:
            measure.labels["process_first"] = str(int(not _seen))
            _seen = True
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
    def __init__(self, app):
        self.app = app

    def route(self, *args, **kwargs):
        register = self.app.route(*args, **kwargs)
        def decorate(handler):
            return register(timed_handler(handler))
        return decorate

    def __getattr__(self, name):
        return getattr(self.app, name)
