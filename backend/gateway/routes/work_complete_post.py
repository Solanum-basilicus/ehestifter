import azure.functions as func
from datetime import datetime, timezone
import logging
import traceback

from helpers.http_json import parse_json, json_response, json_error
from helpers.core_client import get_run, get_latest_id, complete_run_succeeded, complete_run_failed
from helpers.errors import CoreHttpError


def _parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(str(s).replace("Z", "+00:00"))


def _pick(run: dict, *keys: str):
    """Return the first present value among possible key spellings."""
    for k in keys:
        if k in run and run[k] is not None:
            return run[k]
    return None


def register(app: func.FunctionApp):
    @app.route(route="work/complete", methods=["POST"])
    def work_complete(req: func.HttpRequest) -> func.HttpResponse:
        try:
            ok, body, err = parse_json(req)
            if not ok:
                return err
            if not isinstance(body, dict):
                return func.HttpResponse("Body must be object", status_code=400)

            run_id = body.get("runId")
            lease_token = body.get("leaseToken")
            result = body.get("result")
            error = body.get("error")

            if not run_id or not lease_token:
                return func.HttpResponse("Missing runId/leaseToken", status_code=400)
            if (result is None) == (error is None):
                return func.HttpResponse("Provide exactly one of result or error", status_code=400)

            # Load run
            try:
                run = get_run(run_id)
            except CoreHttpError as e:
                if e.status_code == 404:
                    return func.HttpResponse("Not found", status_code=404)
                return json_error("CORE_ERROR", 502, e.body)

            if not isinstance(run, dict):
                return json_error("CORE_INVALID", 502, {"message": "Core returned non-object run"})

            # Pull required fields defensively (support possible casing/shape drift)
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

            # Validate lease token
            if (str(run_lease_token or "")).lower() != str(lease_token).lower():
                return json_error("LEASE_MISMATCH", 409, {"expected": run_lease_token, "got": lease_token})

            # Validate lease expiry
            if not run_lease_until:
                return json_error("LEASE_MISSING", 409)

            try:
                until_dt = _parse_iso(run_lease_until)
            except Exception:
                return json_error("LEASE_INVALID", 409, {"leaseUntil": run_lease_until})

            now = datetime.now(timezone.utc)
            if until_dt < now:
                return json_error("LEASE_EXPIRED", 410, {"leaseUntil": run_lease_until, "now": now.isoformat()})

            # Latest-run check again
            try:
                latest_id = get_latest_id(run_subject_key, run_enricher_type)
            except CoreHttpError as e:
                if e.status_code == 404:
                    return json_error("NOT_LATEST", 409)
                return json_error("CORE_ERROR", 502, e.body)

            if str(latest_id).lower() != str(run_id).lower():
                return json_error("NOT_LATEST", 409, {"latestId": latest_id, "runId": run_id})

            # Forward completion to Core
            try:
                if result is not None:
                    if not isinstance(result, dict):
                        return func.HttpResponse("result must be object", status_code=400)
                    score = result.get("score")
                    summary = result.get("summary")
                    if score is None or summary is None:
                        return func.HttpResponse("Missing result.score/result.summary", status_code=400)
                    complete_run_succeeded(run_id, float(score), str(summary))
                else:
                    if error is not None and not isinstance(error, dict):
                        return func.HttpResponse("error must be object", status_code=400)
                    code = (error.get("code") if isinstance(error, dict) else None) or "WORKER_ERROR"
                    msg = (error.get("message") if isinstance(error, dict) else None) or "Worker reported failure"
                    complete_run_failed(run_id, str(code), str(msg))
            except CoreHttpError as e:
                return json_error("CORE_ERROR", 502, e.body)

            return json_response({"ok": True}, status_code=200)

        except Exception as e:
            logging.exception("Unhandled exception in work_complete")
            return json_error(
                "GATEWAY_UNHANDLED",
                500,
                {"message": str(e), "trace": traceback.format_exc()},
            )
