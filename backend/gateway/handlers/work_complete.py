# handlers/work_complete.py

from datetime import datetime, timezone
import logging
import traceback
from typing import Any, Mapping

from helpers.core_client import (
    get_run,
    get_latest_id,
    complete_run_succeeded,
    complete_run_failed,
)
from helpers.errors import CoreHttpError
from .common import ResponseTuple, json_error, json_result, text_result


def _parse_iso(s: str) -> datetime:
    dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt


def _pick(run: dict, *keys: str):
    """Return the first present value among possible key spellings."""
    for k in keys:
        if k in run and run[k] is not None:
            return run[k]
    return None


def handle_work_complete(
    body: Any,
    headers: Mapping[str, Any] | None = None,
) -> ResponseTuple:
    try:
        if not isinstance(body, dict):
            return text_result("Body must be object", 400)

        run_id = body.get("runId")
        lease_token = body.get("leaseToken")
        result = body.get("result")
        error = body.get("error")

        if not run_id or not lease_token:
            return text_result("Missing runId/leaseToken", 400)

        if (result is None) == (error is None):
            return text_result("Provide exactly one of result or error", 400)

        try:
            run = get_run(run_id)
        except CoreHttpError as e:
            if e.status_code == 404:
                return text_result("Not found", 404)
            return json_error("CORE_ERROR", 502, e.body)

        if not isinstance(run, dict):
            return json_error(
                "CORE_INVALID",
                502,
                {"message": "Core returned non-object run"},
            )

        run_lease_token = _pick(run, "leaseToken", "lease_token")
        run_lease_until = _pick(run, "leaseUntil", "lease_until")
        run_subject_key = _pick(run, "subjectKey", "subject_key")
        run_enricher_type = _pick(run, "enricherType", "enricher_type")

        if not run_subject_key or not run_enricher_type:
            return json_error(
                "CORE_INVALID",
                502,
                {
                    "message": "Missing subjectKey/enricherType in run payload from Core",
                    "keys": sorted(list(run.keys())),
                },
            )

        if str(run_lease_token or "").lower() != str(lease_token).lower():
            return json_error(
                "LEASE_MISMATCH",
                409,
                {"expected": run_lease_token, "got": lease_token},
            )

        if not run_lease_until:
            return json_error("LEASE_MISSING", 409)

        try:
            until_dt = _parse_iso(run_lease_until)
        except Exception:
            return json_error("LEASE_INVALID", 409, {"leaseUntil": run_lease_until})

        now = datetime.now(timezone.utc)
        if until_dt < now:
            return json_error(
                "LEASE_EXPIRED",
                410,
                {"leaseUntil": run_lease_until, "now": now.isoformat()},
            )

        try:
            latest_id = get_latest_id(run_subject_key, run_enricher_type)
        except CoreHttpError as e:
            if e.status_code == 404:
                return json_error("NOT_LATEST", 409)
            return json_error("CORE_ERROR", 502, e.body)

        if str(latest_id).lower() != str(run_id).lower():
            return json_error("NOT_LATEST", 409, {"latestId": latest_id, "runId": run_id})

        try:
            if result is not None:
                if not isinstance(result, dict):
                    return text_result("result must be object", 400)

                score = result.get("score")
                summary = result.get("summary")

                if score is None or summary is None:
                    return text_result("Missing result.score/result.summary", 400)

                complete_run_succeeded(run_id, float(score), str(summary))
            else:
                if error is not None and not isinstance(error, dict):
                    return text_result("error must be object", 400)

                code = (
                    error.get("code")
                    if isinstance(error, dict)
                    else None
                ) or "WORKER_ERROR"

                msg = (
                    error.get("message")
                    if isinstance(error, dict)
                    else None
                ) or "Worker reported failure"

                complete_run_failed(run_id, str(code), str(msg))
        except CoreHttpError as e:
            return json_error("CORE_ERROR", 502, e.body)

        return json_result({"ok": True}, 200)

    except Exception as e:
        logging.exception("Unhandled exception in work_complete")
        return json_error(
            "GATEWAY_UNHANDLED",
            500,
            {"message": str(e), "trace": traceback.format_exc()},
        )
