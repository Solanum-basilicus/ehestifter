# /routes/enrichment_run_complete_post.py
import logging
import azure.functions as func

from helpers.enrichment_completion import complete_run_transactionally
from helpers.analytics import (
    emit_enrichers_event,
    extract_score,
    get_run_analytics_context,
    safe_failure_stage,
)

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

        if status == "Succeeded":
            if not isinstance(result, dict):
                return func.HttpResponse("Succeeded runs must include 'result' object", status_code=400)

        if status == "Failed":
            if error_code is not None and not isinstance(error_code, str):
                return func.HttpResponse("errorCode must be a string or null", status_code=400)
            if error_message is not None and not isinstance(error_message, str):
                return func.HttpResponse("errorMessage must be a string or null", status_code=400)

        if enrichment_attributes is not None and not isinstance(enrichment_attributes, dict):
            return func.HttpResponse("enrichmentAttributes must be an object or null", status_code=400)

        try:
            outcome = complete_run_transactionally(
                run_id=run_id,
                status=status,
                result_json=result,
                attributes_json=enrichment_attributes,
                error_code=error_code,
                error_message=error_message,
            )

            if outcome.outcome == "completed":
                run_ctx = get_run_analytics_context(run_id)

                if run_ctx:
                    props = {
                        "job_id": run_ctx.get("jobOfferingId"),
                        "run_id": run_ctx.get("runId"),
                        "enricher_type": run_ctx.get("enricherType"),
                    }

                    if status == "Succeeded":
                        score = extract_score(result)
                        if score is not None:
                            props["score"] = score

                        emit_enrichers_event(
                            "Compatibility Completed",
                            user_id=run_ctx.get("userId"),
                            source_surface="worker",
                            subject_type="enrichment_run",
                            subject_id=run_ctx.get("runId"),
                            properties=props,
                        )

                    elif status == "Failed":
                        failure_stage = safe_failure_stage(error_code)
                        if failure_stage:
                            props["failure_stage"] = failure_stage

                        emit_enrichers_event(
                            "Compatibility Failed",
                            user_id=run_ctx.get("userId"),
                            source_surface="worker",
                            subject_type="enrichment_run",
                            subject_id=run_ctx.get("runId"),
                            properties=props,
                        )

            # old/stale/already-terminal completion should still be non-fatal for Gateway
            if outcome.outcome in ("completed", "stale_ignored", "already_terminal"):
                return func.HttpResponse(status_code=204)

            logging.error("Unexpected completion outcome for run %s: %s", run_id, outcome.outcome)
            return func.HttpResponse("Unexpected completion outcome", status_code=500)

        except ValueError as ex:
            msg = str(ex)
            if msg == "Run not found":
                return func.HttpResponse(msg, status_code=404)
            return func.HttpResponse(msg, status_code=409)

        except Exception:
            logging.exception("POST /enrichment/runs/%s/complete failed", run_id)
            return func.HttpResponse("Error completing enrichment run", status_code=500)