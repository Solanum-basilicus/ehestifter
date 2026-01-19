# enrichers/routes/enrichment_history_get.py
import json
import logging
import azure.functions as func

from domain.runs_service import RunsService


def register(app: func.FunctionApp):
    svc = RunsService()

    @app.route(route="enrichment/subjects/{jobId:guid}/{userId:guid}/history", methods=["GET"])
    def enrichment_history(req: func.HttpRequest) -> func.HttpResponse:
        job_id = req.route_params.get("jobId")
        user_id = req.route_params.get("userId")
        enricher_type = req.params.get("enricherType") or "compatibility.v1"
        limit = int(req.params.get("limit") or 50)
        offset = int(req.params.get("offset") or 0)

        # soft bounds
        if limit < 1:
            limit = 1
        if limit > 200:
            limit = 200
        if offset < 0:
            offset = 0

        logging.info(
            "GET enrichment history: job=%s user=%s enricherType=%s limit=%s offset=%s",
            job_id, user_id, enricher_type, limit, offset
        )

        try:
            items = svc.get_history(job_id, user_id, enricher_type, limit=limit, offset=offset)
            return func.HttpResponse(json.dumps({"items": items, "limit": limit, "offset": offset}),
                                     mimetype="application/json", status_code=200)
        except Exception as e:
            logging.exception("GET enrichment history failed")
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)
