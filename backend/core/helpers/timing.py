"""Request-local timing for Core and allowlisted downstream HTTP services."""

import re
from math import isfinite
from threading import Lock
from time import perf_counter

from flask import g, has_request_context

_STARTED = perf_counter()
_SEEN = False
_LOCK = Lock()

# Accept only known fields. Never forward arbitrary downstream header text.
_JOBS_NUMBERS = frozenset({
    "app", "sql", "dbconn", "process_age", "step_job_row", "step_legacy_locations",
    "step_catalog_load", "step_catalog_parse", "step_catalog_index", "step_locations_v2",
    "step_location_lookup",
    "step_work_time", "step_serialize", "step_parse", "step_query_build",
    "step_count_query", "step_page_query", "step_location_hydration", "step_location_v2_hydration",
    "step_country_lookup", "step_location_v2_query", "step_bulk_parse", "step_bulk_query",
    "step_bulk_format", "startup_azure", "startup_routes",
    "startup_register", "startup_total",
})
_ENRICHERS_NUMBERS = frozenset({
    "app", "process_age", "step_run_create", "step_run_readback", "step_analytics",
    "step_job_snapshot", "step_cv_snapshot", "step_snapshot_validate", "step_blob_upload",
    "step_snapshot_path_update", "step_gateway_dispatch", "step_mark_queued",
    "gateway_http", "gateway_app", "gateway_process_age", "gateway_unattributed",
    "gateway_step_servicebus_dispatch", "gateway_step_servicebus_client",
    "gateway_step_servicebus_sender", "gateway_step_servicebus_send",
    "users_http", "users_app", "users_dbconn", "users_sql", "users_process_age",
    "users_unattributed", "users_step_cv_lookup", "users_step_blob_client",
    "users_step_blob_download", "users_step_serialize",
})
_USERS_NUMBERS = frozenset({
    "app", "dbconn", "sql", "process_age", "step_cv_lookup",
    "step_blob_client", "step_blob_download", "step_blob_upload",
    "step_cv_convert", "step_discovery_query", "step_profile_normalize",
    "step_cv_batch_download", "step_readiness", "step_analytics",
    "step_serialize", "step_user_lookup",
})
_LABELS = frozenset({"process_first", "catalog_cache", "sql_count", "location_display", "country_lookup_source", "process_tag"})
_ENRICHERS_LABELS = frozenset({
    "process_first", "gateway_process_first", "users_process_first", "users_sql_count",
})
_USERS_LABELS = frozenset({"process_first", "sql_count"})
_FIELD = re.compile(r'\s*([a-z0-9_]+);(dur=([0-9]+(?:\.[0-9]+)?)|desc="([a-z0-9_]+)")\s*')


def begin_request():
    global _SEEN
    g.timing_start = perf_counter()
    g.timing_values = {"process_age": (g.timing_start - _STARTED) * 1000}
    g.timing_labels = {}
    with _LOCK:
        g.timing_labels["process_first"] = str(int(not _SEEN))
        _SEEN = True


def add_duration(name, ms):
    if has_request_context() and hasattr(g, "timing_values"):
        g.timing_values[name] = g.timing_values.get(name, 0.0) + ms


def set_label(name, value):
    if has_request_context() and hasattr(g, "timing_labels"):
        if name == "users_cache" and g.timing_labels.get(name) == "miss":
            return
        g.timing_labels[name] = str(value)


def measure_call(name, callback):
    start = perf_counter()
    try:
        return callback()
    finally:
        add_duration(name, (perf_counter() - start) * 1000)


def _read_upstream(header, numbers, labels):
    values, texts = {}, {}
    for part in (header or "")[:4096].split(",")[:80]:
        match = _FIELD.fullmatch(part)
        if not match:
            continue
        key = match.group(1)
        if match.group(3) is not None and key in numbers:
            value = float(match.group(3))
            if isfinite(value):
                values[key] = value
        elif match.group(4) is not None and key in labels:
            value = match.group(4)
            if key.endswith("process_first") and value not in ("0", "1"):
                continue
            if key.endswith("sql_count") and (not value.isdigit() or len(value) > 7):
                continue
            if key == "catalog_cache" and value not in ("hit", "miss"):
                continue
            if key in ("location_display", "country_lookup_source") and value not in ("index", "fallback", "stored"):
                continue
            if key == "process_tag" and (len(value) != 8 or any(ch not in "0123456789abcdef" for ch in value)):
                continue
            texts[key] = value
    return values, texts


def downstream_call(service, callback):
    """Measure a request attempt, including time before an HTTP response exists."""
    if service not in ("jobs", "enrichers", "users"):
        raise ValueError("Unknown downstream service")
    numbers = {"jobs": _JOBS_NUMBERS, "enrichers": _ENRICHERS_NUMBERS, "users": _USERS_NUMBERS}[service]
    labels = {"jobs": _LABELS, "enrichers": _ENRICHERS_LABELS, "users": _USERS_LABELS}[service]
    if service == "jobs" and has_request_context() and hasattr(g, "timing_labels"):
        set_label("attempts", int(g.timing_labels.get("attempts", "0")) + 1)
    started = perf_counter()
    parsed = {}
    try:
        response = callback()
        parsed, descriptions = _read_upstream(
            (getattr(response, "headers", {}) or {}).get("Server-Timing", ""), numbers, labels
        )
        if has_request_context() and hasattr(g, "timing_values"):
            for name, value in parsed.items():
                key = service + "_" + name
                if name in ("process_age", "gateway_process_age", "users_process_age") or name.startswith("startup_"):
                    # Startup values are process observations, not request totals.
                    # Process age is one observation, not a duration to add.
                    g.timing_values[key] = value
                else:
                    add_duration(key, value)
            for name, value in descriptions.items():
                key = service + "_" + name
                previous = g.timing_labels.get(key)
                if name in ("sql_count", "users_sql_count"):
                    value = int(previous or "0") + int(value)
                elif name in ("process_first", "gateway_process_first", "users_process_first"):
                    value = "1" if value == "1" or previous == "1" else "0"
                elif name == "catalog_cache" and previous == "miss":
                    value = "miss"
                set_label(key, value)
        return response
    finally:
        elapsed = (perf_counter() - started) * 1000
        add_duration(service + "_http", elapsed)
        # Only calculate this when the returned handler duration is known.
        if "app" in parsed:
            add_duration(service + "_unattributed", max(0, elapsed - parsed["app"]))


def jobs_call(callback):
    return downstream_call("jobs", callback)


def enrichers_call(callback):
    return downstream_call("enrichers", callback)


def users_call(callback):
    return downstream_call("users", callback)


def finish_request(response):
    if not hasattr(g, "timing_start"):
        return response
    elapsed = (perf_counter() - g.timing_start) * 1000
    values = {"core": elapsed, **g.timing_values}
    parts = [f"{name};dur={value:.2f}" for name, value in values.items()]
    parts.extend(f'{name};desc="{value}"' for name, value in g.timing_labels.items())
    response.headers["Server-Timing"] = ", ".join(parts)
    return response
