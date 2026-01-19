# enrichers/routes/enrichment_runs_post.py
import json
import logging
import azure.functions as func

from domain.runs_service import RunsService


def register(app: func.FunctionApp):
    svc = RunsService()

    @app.route(route="enrichment/runs", methods=["POST"])
    def create_enrichment_run(req: func.HttpRequest) -> func.HttpResponse:
        """
        Body:
        {
          "jobOfferingId": "...",
          "userId": "...",
          "enricherType": "compatibility.v1"
        }
        """
        try:
            body = req.get_json()
        except Exception:
            return func.HttpResponse("Invalid JSON body", status_code=400)

        job_id = body.get("jobOfferingId") or body.get("jobId")
        user_id = body.get("userId")
        enricher_type = body.get("enricherType") or "compatibility.v1"

        if not job_id or not user_id:
            return func.HttpResponse("Missing jobOfferingId/userId", status_code=400)

        logging.info("POST /enrichment/runs job=%s user=%s enricherType=%s", job_id, user_id, enricher_type)

        try:
            run = svc.create_run(job_id, user_id, enricher_type)
            return func.HttpResponse(json.dumps(run), mimetype="application/json", status_code=201)
        except Exception as e:
            logging.exception("POST /enrichment/runs failed")
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)
