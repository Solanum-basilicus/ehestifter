# main.py

import logging
import os
from typing import Any

from flask import Flask, Response, jsonify, request, g
from time import perf_counter
from helpers.timing import begin as begin_timing, end as end_timing
from handlers.common import require_gateway_key

##### For local testing uncomment those
#from dotenv import load_dotenv
#load_dotenv()
#####

from handlers.gateway_dispatch import handle_gateway_dispatch
from handlers.work_lease import handle_work_lease
from handlers.work_complete import handle_work_complete


logging.getLogger("azure").setLevel(logging.WARNING)
logging.getLogger("uamqp").setLevel(logging.WARNING)
logging.getLogger("azure.servicebus").setLevel(logging.WARNING)

def _require_cloudrun_key():
    auth_error = require_gateway_key(request.headers)
    if auth_error:
        return _flask_response(auth_error)
    return None

def _flask_response(result) -> Response:
    body, status_code, headers = result

    if isinstance(body, str):
        resp = Response(body, status=status_code, mimetype="text/plain")
    else:
        resp = jsonify(body)
        resp.status_code = status_code

    for key, value in headers.items():
        resp.headers[key] = value

    return resp


def create_app() -> Flask:
    app = Flask(__name__)

    @app.before_request
    def start_timing():
        g.timing_token, g.timing_measure, g.timing_start = begin_timing()

    @app.after_request
    def finish_timing(response):
        response.headers["Server-Timing"] = g.timing_measure.header(
            (perf_counter() - g.timing_start) * 1000
        )
        end_timing(g.timing_token)
        return response

    @app.get("/ping")
    def ping():
        logging.info("gateway ping processed a request.")
        return Response("pong", status=200, mimetype="text/plain")

    @app.get("/healthz")
    def healthz():
        return jsonify({"ok": True, "service": "ehestifter-gateway"})

    @app.post("/gateway/dispatch")
    def gateway_dispatch():
        #AUTH
        auth_error = _require_cloudrun_key()
        if auth_error:
            return auth_error        

        body: Any = request.get_json(silent=True)
        if body is None:
            return Response("Invalid JSON body", status=400, mimetype="text/plain")

        return _flask_response(
            handle_gateway_dispatch(
                body=body,
                headers=request.headers,
            )
        )

    @app.post("/work/lease")
    def work_lease():
        #AUTH
        auth_error = _require_cloudrun_key()
        if auth_error:
            return auth_error        

        body: Any = request.get_json(silent=True)
        if body is None:
            return Response("Invalid JSON body", status=400, mimetype="text/plain")

        return _flask_response(
            handle_work_lease(
                body=body,
                headers=request.headers,
            )
        )

    @app.post("/work/complete")
    def work_complete():
        #AUTH
        auth_error = _require_cloudrun_key()
        if auth_error:
            return auth_error        

        body: Any = request.get_json(silent=True)
        if body is None:
            return Response("Invalid JSON body", status=400, mimetype="text/plain")

        return _flask_response(
            handle_work_complete(
                body=body,
                headers=request.headers,
            )
        )

    return app


app = create_app()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port)
