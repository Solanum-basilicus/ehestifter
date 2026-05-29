# routes/work_lease_post.py

import json

import azure.functions as func

from handlers.work_lease import handle_work_lease
from helpers.http_json import parse_json


def _to_http_response(result) -> func.HttpResponse:
    body, status_code, headers = result

    if isinstance(body, str):
        resp = func.HttpResponse(body, status_code=status_code)
    else:
        resp = func.HttpResponse(
            json.dumps(body),
            mimetype="application/json",
            status_code=status_code,
        )

    for key, value in headers.items():
        resp.headers[key] = value

    return resp


def register(app: func.FunctionApp):
    @app.route(route="work/lease", methods=["POST"])
    def work_lease(req: func.HttpRequest) -> func.HttpResponse:
        ok, body, err = parse_json(req)
        if not ok:
            return err

        return _to_http_response(
            handle_work_lease(
                body=body,
                headers=req.headers,
            )
        )