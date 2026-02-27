import json
import logging
import uuid

import azure.functions as func
from helpers.http_json import parse_json, json_response
from helpers.sb_client import send_dispatch_message


def _corr_id(req: func.HttpRequest) -> str:
    # Use client-provided ids if present, otherwise generate.
    return (
        req.headers.get("x-correlation-id")
        or req.headers.get("x-ms-client-request-id")
        or req.headers.get("x-request-id")
        or str(uuid.uuid4())
    )


def register(app: func.FunctionApp):
    @app.route(route="gateway/dispatch", methods=["POST"])  # keep your auth_level as-is for now
    def gateway_dispatch(req: func.HttpRequest) -> func.HttpResponse:
        corr = _corr_id(req)

        # Log header presence (NOT values) to diagnose missing corr from callers
        hk = {k.lower() for k in req.headers.keys()}
        logging.info(
            "POST /gateway/dispatch start corr=%s has_x_corr=%s has_x_ms_req=%s",
            corr,
            ("x-correlation-id" in hk),
            ("x-ms-client-request-id" in hk),
        )

        ok, body, err = parse_json(req)
        if not ok:
            logging.warning("POST /gateway/dispatch bad_json corr=%s", corr)
            # If parse_json returned an HttpResponse, pass it through (can't attach headers reliably)
            return err

        if not isinstance(body, dict) or not body.get("runId"):
            logging.warning(
                "POST /gateway/dispatch missing_runId corr=%s body_type=%s keys=%s",
                corr,
                type(body).__name__,
                sorted(body.keys()) if isinstance(body, dict) else None,
            )
            resp = func.HttpResponse("Missing runId", status_code=400)
            resp.headers["x-correlation-id"] = corr
            return resp

        run_id = str(body.get("runId") or "")
        logging.info(
            "POST /gateway/dispatch parsed corr=%s runId=%s enricherType=%s subjectKey=%s",
            corr,
            run_id,
            body.get("enricherType"),
            body.get("subjectKey"),
        )

        try:
            message_id = send_dispatch_message(body, corr=corr)
        except Exception as e:
            logging.exception("POST /gateway/dispatch SB dispatch failed corr=%s runId=%s", corr, run_id)
            resp = func.HttpResponse(
                json.dumps({"code": "SB_DISPATCH_FAILED", "message": str(e), "runId": run_id, "corr": corr}),
                mimetype="application/json",
                status_code=502,
            )
            resp.headers["x-correlation-id"] = corr
            return resp

        logging.info("POST /gateway/dispatch ok corr=%s runId=%s messageId=%s", corr, run_id, message_id)

        resp = json_response({"messageId": message_id, "runId": run_id, "corr": corr}, status_code=202)
        resp.headers["x-correlation-id"] = corr
        return resp