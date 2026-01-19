# enrichers/routes/enrichment_latest_get.py
import json
import logging
import azure.functions as func

from domain.runs_service import RunsService


def register(app: func.FunctionApp):
    svc = RunsService()

    @app.route(route="enrichment/subjects/{jobId:guid}/{userId:guid}/latest", methods=["GET"])
    def enrichment_latest(req: func.HttpRequest) -> func.HttpResponse:
        job_id = req.route_params.get("jobId")
        user_id = req.route_params.get("userId")
        enricher_type = req.params.get("enricherType") or "compatibility.v1"

        logging.info("GET latest enrichment: job=%s user=%s enricherType=%s", job_id, user_id, enricher_type)

        try:
            run = svc.get_latest(job_id, user_id, enricher_type)
            if not run:
                return func.HttpResponse("Not found", status_code=404)
            return func.HttpResponse(json.dumps(run), mimetype="application/json", status_code=200)
        except Exception as e:
            logging.exception("GET latest enrichment failed")
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)
