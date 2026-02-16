# routes/internal_lease_post.py
import json
from datetime import datetime
import azure.functions as func

from helpers.enrichment_runs_db import try_lease_run


def register(app: func.FunctionApp):
    @app.route(route="internal/enrichment/runs/{runId:guid}/lease", methods=["POST"])
    def internal_lease(req: func.HttpRequest) -> func.HttpResponse:
        run_id = req.route_params["runId"]

        try:
            body = req.get_json()
            if not isinstance(body, dict):
                return func.HttpResponse("Body must be JSON object", status_code=400)
        except Exception:
            return func.HttpResponse("Invalid JSON body", status_code=400)

        lease_token = body.get("leaseToken")
        lease_until_raw = body.get("leaseUntil")
        if not lease_token or not lease_until_raw:
            return func.HttpResponse("Missing leaseToken/leaseUntil", status_code=400)

        try:
            # Accept “Z” or offset forms; datetime.fromisoformat doesn’t parse Z in older versions
            s = str(lease_until_raw).replace("Z", "+00:00")
            lease_until = datetime.fromisoformat(s)
        except Exception:
            return func.HttpResponse("Invalid leaseUntil; must be ISO8601", status_code=400)

        ok, code = try_lease_run(run_id, str(lease_token), lease_until)
        if ok:
            return func.HttpResponse(status_code=204)

        if code == "RUN_NOT_FOUND":
            return func.HttpResponse("Not found", status_code=404)

        payload = {"code": code}
        return func.HttpResponse(json.dumps(payload), mimetype="application/json", status_code=409)
