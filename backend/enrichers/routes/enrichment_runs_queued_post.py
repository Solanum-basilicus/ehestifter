# enrichers/routes/enrichment_runs_queued_post.py
import json
import logging
import os
import azure.functions as func

from helpers.runs_create import mark_queued_by_gateway
from domain.runs_service import RunsService  # for normalized response

def _require_internal_key(req: func.HttpRequest) -> bool:
    expected = os.getenv("ENRICHERS_INTERNAL_API_KEY")
    if not expected:
        return True
    got = req.headers.get("x-api-key") or req.headers.get("x-functions-key")
    return got == expected

def register(app: func.FunctionApp):
    svc = RunsService()

    @app.route(route="enrichment/runs/{runId}/queued", methods=["POST"])
    def mark_run_queued(req: func.HttpRequest) -> func.HttpResponse:
        if not _require_internal_key(req):
            return func.HttpResponse("Unauthorized", status_code=401)

        run_id = req.route_params.get("runId")
        corr = req.headers.get("x-correlation-id") or req.headers.get("x-ms-client-request-id")
        logging.info("POST /enrichment/runs/%s/queued corr=%s", run_id, corr)

        if not run_id:
            return func.HttpResponse("Missing runId", status_code=400)

        try:
            status_after, updated = mark_queued_by_gateway(run_id)
        except ValueError:
            return func.HttpResponse("Not found", status_code=404)
        except Exception as e:
            logging.exception("mark_run_queued failed runId=%s corr=%s", run_id, corr)
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)

        # If it wasn't Pending/Queued, treat as conflict (gateway shouldn't queue stale runs)
        if status_after not in ("Queued",):
            return func.HttpResponse(
                json.dumps({"ok": False, "status": status_after, "updated": updated}),
                mimetype="application/json",
                status_code=409,
            )

        # Return canonical normalized run
        try:
            run = svc.get_run(run_id)
        except Exception:
            # Fallback minimal response if normalization fails
            run = {"runId": run_id, "status": status_after}

        return func.HttpResponse(
            json.dumps({"ok": True, "updated": updated, "run": run}),
            mimetype="application/json",
            status_code=200,
        )