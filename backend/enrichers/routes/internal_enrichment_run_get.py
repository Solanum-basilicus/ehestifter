# routes/internal_enrichment_run_get.py
import json
import azure.functions as func

from helpers.enrichment_runs_db import get_run_by_id


def register(app: func.FunctionApp):
    @app.route(route="internal/enrichment/runs/{runId:guid}", methods=["GET"])
    def internal_run_get(req: func.HttpRequest) -> func.HttpResponse:
        run_id = req.route_params["runId"]
        run = get_run_by_id(run_id)
        if not run:
            return func.HttpResponse("Not found", status_code=404)
        return func.HttpResponse(json.dumps(run), mimetype="application/json", status_code=200)
