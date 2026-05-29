# handlers/gateway_dispatch.py

import logging
from typing import Any, Mapping

from helpers.sb_client import send_dispatch_message
from .common import ResponseTuple, correlation_id, json_result, text_result


def handle_gateway_dispatch(
    body: Any,
    headers: Mapping[str, Any] | None = None,
) -> ResponseTuple:
    corr = correlation_id(headers)
    response_headers = {"x-correlation-id": corr}

    header_keys = {str(k).lower() for k in (headers or {}).keys()}
    logging.info(
        "POST /gateway/dispatch start corr=%s has_x_corr=%s has_x_ms_req=%s",
        corr,
        ("x-correlation-id" in header_keys),
        ("x-ms-client-request-id" in header_keys),
    )

    if not isinstance(body, dict) or not body.get("runId"):
        logging.warning(
            "POST /gateway/dispatch missing_runId corr=%s body_type=%s keys=%s",
            corr,
            type(body).__name__,
            sorted(body.keys()) if isinstance(body, dict) else None,
        )
        return text_result("Missing runId", 400, response_headers)

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
        logging.exception(
            "POST /gateway/dispatch SB dispatch failed corr=%s runId=%s",
            corr,
            run_id,
        )
        return json_result(
            {
                "code": "SB_DISPATCH_FAILED",
                "message": str(e),
                "runId": run_id,
                "corr": corr,
            },
            502,
            response_headers,
        )

    logging.info(
        "POST /gateway/dispatch ok corr=%s runId=%s messageId=%s",
        corr,
        run_id,
        message_id,
    )

    return json_result(
        {"messageId": message_id, "runId": run_id, "corr": corr},
        202,
        response_headers,
    )
