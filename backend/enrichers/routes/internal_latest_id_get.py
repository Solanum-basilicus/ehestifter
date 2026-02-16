# routes/internal_latest_id_get.py
import json
import azure.functions as func

from helpers.enrichment_runs_db import get_latest_run_id


def register(app: func.FunctionApp):
    @app.route(route="internal/enrichment/subjects/{subjectKey}/{enricherType}/latest-id", methods=["GET"])
    def internal_latest_id(req: func.HttpRequest) -> func.HttpResponse:
        subject_key = req.route_params["subjectKey"]
        enricher_type = req.route_params["enricherType"]

        run_id = get_latest_run_id(subject_key, enricher_type)
        if not run_id:
            return func.HttpResponse("Not found", status_code=404)
        return func.HttpResponse(
            json.dumps({"runId": run_id}),
            mimetype="application/json",
            status_code=200,
        )
