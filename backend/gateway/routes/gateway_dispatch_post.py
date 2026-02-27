# routes/gateway_dispatch_post.py
import json
import logging
import azure.functions as func

from helpers.http_json import parse_json, json_response
from helpers.sb_client import send_dispatch_message


def _corr_id(req: func.HttpRequest) -> str:
    return (
        req.headers.get("x-correlation-id")
        or req.headers.get("x-ms-client-request-id")
        or req.headers.get("x-request-id")
        or ""
    )


def register(app: func.FunctionApp):
    # Make auth behavior explicit. If you rely on function keys, keep FUNCTION.
    @app.route(route="gateway/dispatch", methods=["POST"], auth_level=func.AuthLevel.FUNCTION)
    def gateway_dispatch(req: func.HttpRequest) -> func.HttpResponse:
        corr = _corr_id(req)

        # NOTE: if platform auth blocks the request, this function won't execute at all.
        logging.info("POST /gateway/dispatch start corr=%s", corr)

        ok, body, err = parse_json(req)
        if not ok:
            logging.warning("POST /gateway/dispatch bad_json corr=%s", corr)
            return err

        if not isinstance(body, dict):
            logging.warning("POST /gateway/dispatch invalid_body_type corr=%s type=%s", corr, type(body).__name__)
            return func.HttpResponse("Invalid JSON body", status_code=400)

        run_id = body.get("runId")
        if not run_id:
            logging.warning("POST /gateway/dispatch missing_runId corr=%s keys=%s", corr, sorted(body.keys()))
            return func.HttpResponse("Missing runId", status_code=400)

        # Log a safe summary (no secrets)
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
            return func.HttpResponse(
                json.dumps({"code": "SB_DISPATCH_FAILED", "message": str(e), "runId": run_id, "corr": corr}),
                mimetype="application/json",
                status_code=502,
            )

        logging.info("POST /gateway/dispatch ok corr=%s runId=%s messageId=%s", corr, run_id, message_id)
        return json_response({"messageId": message_id, "runId": run_id, "corr": corr}, status_code=202)