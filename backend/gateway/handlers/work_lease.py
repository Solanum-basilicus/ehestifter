# handlers/work_lease.py

from typing import Any, Mapping

from helpers.core_client import get_run, get_latest_id, lease_run, get_input
from helpers.errors import CoreHttpError
from helpers.lease_logic import compute_lease, is_latest
from .common import ResponseTuple, json_error, json_result, text_result, require_gateway_key


def handle_work_lease(
    body: Any,
    headers: Mapping[str, Any] | None = None,
) -> ResponseTuple:
    auth_error = require_gateway_key(headers)
    if auth_error:
        return auth_error

    if not isinstance(body, dict) or not body.get("runId"):
        return text_result("Missing runId", 400)

    run_id = body["runId"]

    try:
        run = get_run(run_id)
    except CoreHttpError as e:
        if e.status_code == 404:
            return text_result("Not found", 404)
        return json_error("CORE_ERROR", 502, e.body)

    try:
        latest_id = get_latest_id(run["subjectKey"], run["enricherType"])
    except CoreHttpError as e:
        if e.status_code == 404:
            return json_error("NOT_LATEST", 409)
        return json_error("CORE_ERROR", 502, e.body)

    if not is_latest(run, latest_id):
        return json_error("NOT_LATEST", 409)

    lease_token, lease_until = compute_lease()

    try:
        conflict = lease_run(run_id, lease_token, lease_until)
    except CoreHttpError as e:
        if e.status_code == 404:
            return text_result("Not found", 404)
        return json_error("CORE_ERROR", 502, e.body)

    if conflict:
        return json_result({"code": conflict}, 409)

    try:
        snapshot = get_input(run_id)
    except CoreHttpError as e:
        if e.status_code == 409:
            return json_error("SNAPSHOT_MISSING", 409, e.body)
        if e.status_code == 404:
            return json_error("BLOB_NOT_FOUND", 404, e.body)
        return json_error("CORE_ERROR", 502, e.body)

    return json_result(
        {
            "runId": run_id,
            "leaseToken": lease_token,
            "leaseUntil": lease_until,
            "enricherType": run["enricherType"],
            "subjectKey": run["subjectKey"],
            "input": snapshot,
        },
        200,
    )
