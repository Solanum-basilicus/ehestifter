# enrichers/routes/enrichment_runs_post.py
import json
import logging
import azure.functions as func

from helpers.enrichment_snapshot import write_input_snapshot
from helpers.runs_create import create_run_db, mark_queued, mark_failed, dispatch_via_gateway
from domain.runs_service import RunsService  # keep for get_run normalization

def register(app: func.FunctionApp):
    svc = RunsService()

    @app.route(route="enrichment/runs", methods=["POST"])
    def create_enrichment_run(req: func.HttpRequest) -> func.HttpResponse:
        try:
            body = req.get_json()
        except Exception:
            return func.HttpResponse("Invalid JSON body", status_code=400)

        job_id = body.get("jobOfferingId") or body.get("jobId")
        user_id = body.get("userId")
        enricher_type = body.get("enricherType") or "compatibility.v1"

        corr = req.headers.get("x-correlation-id") or req.headers.get("x-ms-client-request-id")
        logging.info("POST /enrichment/runs corr=%s body=%s", corr, body)

        if not job_id or not user_id:
            return func.HttpResponse("Missing jobOfferingId/userId", status_code=400)

        logging.info("POST /enrichment/runs job=%s user=%s enricherType=%s corr=%s", job_id, user_id, enricher_type, corr)

        # 1) DB create (Pending)
        run = create_run_db(job_id, user_id, enricher_type)

        # 2) Snapshot write (if this fails -> Failed; worker cannot proceed)
        try:
            snapshot = {
                "runId": run["runId"],
                "enricherType": run["enricherType"],
                "subjectKey": run["subjectKey"],
                "jobOfferingId": run["jobOfferingId"],
                "userId": run["userId"],
                "job": {"title": None, "description": None},  # TODO real data
                "cv": {"text": None},                         # TODO real data
                "meta": {"source": "core", "version": 1},
            }
            blob_path = write_input_snapshot(run, snapshot)
            run["inputSnapshotBlobPath"] = blob_path
        except Exception as e:
            logging.exception("POST /enrichment/runs snapshot failed corr=%s", corr)
            mark_failed(run["runId"], "SnapshotWriteFailed", str(e))
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)

        # 3) Dispatch to gateway (if this fails -> leave Pending; return 500; gateway sweep will pick it up)
        try:
            dispatch_via_gateway(run, run["inputSnapshotBlobPath"], corr=corr)
        except Exception as e:
            logging.exception("POST /enrichment/runs dispatch failed corr=%s", corr)
            # IMPORTANT: leave run Pending for scheduled catch-up
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)

        # 4) Mark queued only after successful dispatch
        try:
            mark_queued(run["runId"])
            run = svc.get_run(run["runId"])
            return func.HttpResponse(json.dumps(run), mimetype="application/json", status_code=201)
        except Exception as e:
            # If this fails, we *did* enqueue. Better to return 500 and rely on later consistency check.
            logging.exception("POST /enrichment/runs mark_queued failed corr=%s", corr)
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)