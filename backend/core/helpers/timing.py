"""HTTP timing for Web Core. Each Flask request owns its own measurements."""

import re
from time import perf_counter

from flask import g, has_request_context


# Accept only known numeric Jobs metrics. Never forward untrusted header text.
_JOB_NUMBERS = re.compile(r'(app|sql|dbconn);dur=([0-9]+(?:\.[0-9]+)?)')
_JOB_COUNT = re.compile(r'sql_count;desc="([0-9]+)"')


def begin_request():
    g.timing_start = perf_counter()
    g.timing_values = {}
    g.timing_labels = {}


def add_duration(name, ms):
    if has_request_context() and hasattr(g, "timing_values"):
        g.timing_values[name] = g.timing_values.get(name, 0.0) + ms


def set_label(name, value):
    if has_request_context() and hasattr(g, "timing_labels"):
        g.timing_labels[name] = str(value)


def measure_call(name, callback):
    start = perf_counter()
    try:
        return callback()
    finally:
        add_duration(name, (perf_counter() - start) * 1000)


def jobs_call(callback):
    """Measure one Jobs HTTP attempt and read its Server-Timing response."""
    def invoke():
        response = callback()
        if has_request_context() and hasattr(g, "timing_values"):
            headers = getattr(response, "headers", {}) or {}
            values = headers.get("Server-Timing", "")
            for field, value in _JOB_NUMBERS.findall(values):
                add_duration("jobs_" + field, float(value))
            found = _JOB_COUNT.search(values)
            if found:
                count = int(g.timing_labels.get("jobs_sql_count", "0"))
                set_label("jobs_sql_count", count + int(found.group(1)))
        return response

    if has_request_context() and hasattr(g, "timing_values"):
        set_label("attempts", int(g.timing_labels.get("attempts", "0")) + 1)
    return measure_call("jobs_http", invoke)


def finish_request(response):
    if not hasattr(g, "timing_start"):
        return response
    ms = (perf_counter() - g.timing_start) * 1000
    values = {"core": ms, **g.timing_values}
    parts = [f"{name};dur={value:.2f}" for name, value in values.items()]
    parts.extend(f'{name};desc="{value}"' for name, value in g.timing_labels.items())
    response.headers["Server-Timing"] = ", ".join(parts)
    return response
