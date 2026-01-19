import logging
import azure.functions as func
from domain.runs_service import RunsService

def register(app: func.FunctionApp):
    @app.route(route="enrichment/runs/{runId:guid}/complete", methods=["POST"])
    def complete(req: func.HttpRequest) -> func.HttpResponse:
        run_id = req.route_params["runId"]
        try:
            body = req.get_json()
            svc = RunsService()
            svc.complete_run(
                run_id=run_id,
                status=body["status"],  # "Succeeded" or "Failed"
                result_json=body.get("resultJson"),
                attributes_json=body.get("enrichmentAttributesJson"),
                error_code=body.get("errorCode"),
                error_message=body.get("errorMessage"),
            )
            return func.HttpResponse(status_code=204)
        except Exception:
            logging.exception("POST /enrichment/runs/{runId}/complete error")
            return func.HttpResponse("Error", status_code=500)
