import json
import logging
import azure.functions as func
from domain.runs_service import RunsService


def register(app: func.FunctionApp):
    @app.route(route="enrichment/runs/{runId:guid}/complete", methods=["POST"])
    def complete(req: func.HttpRequest) -> func.HttpResponse:
        run_id = req.route_params["runId"]

        try:
            body = req.get_json()
            if not isinstance(body, dict):
                return func.HttpResponse("Body must be a JSON object", status_code=400)
        except ValueError:
            return func.HttpResponse("Invalid JSON body", status_code=400)

        status = body.get("status")
        if status not in ("Succeeded", "Failed"):
            return func.HttpResponse("status must be 'Succeeded' or 'Failed'", status_code=400)

        result = body.get("result")
        enrichment_attributes = body.get("enrichmentAttributes")
        error_code = body.get("errorCode")
        error_message = body.get("errorMessage")

        # Validate success payload
        if status == "Succeeded":
            if not isinstance(result, dict):
                return func.HttpResponse("Succeeded runs must include 'result' object", status_code=400)
            score = result.get("score")
            summary = result.get("summary")
            if score is None or summary is None:
                return func.HttpResponse("Succeeded runs require result.score and result.summary", status_code=400)

        # Validate failed payload (lightly; keep flexible)
        if status == "Failed":
            # If provided, should be strings
            if error_code is not None and not isinstance(error_code, str):
                return func.HttpResponse("errorCode must be a string or null", status_code=400)
            if error_message is not None and not isinstance(error_message, str):
                return func.HttpResponse("errorMessage must be a string or null", status_code=400)

        # Validate enrichmentAttributes if provided
        if enrichment_attributes is not None and not isinstance(enrichment_attributes, dict):
            return func.HttpResponse("enrichmentAttributes must be an object or null", status_code=400)

        try:
            svc = RunsService()
            svc.complete_run(
                run_id=run_id,
                status=status,
                result_json=result,  # internal DB storage (json string)
                attributes_json=enrichment_attributes,
                error_code=error_code,
                error_message=error_message,
            )
            return func.HttpResponse(status_code=204)

        except Exception:
            logging.exception("POST /enrichment/runs/%s/complete failed", run_id)
            return func.HttpResponse("Error completing enrichment run", status_code=500)
