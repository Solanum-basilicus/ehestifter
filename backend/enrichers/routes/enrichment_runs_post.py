# enrichers/routes/enrichment_runs_post.py
import json
import logging
import azure.functions as func

from helpers.enrichment_snapshot import write_input_snapshot
from helpers.runs_create import create_run_db, mark_queued, mark_failed
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

        if not job_id or not user_id:
            return func.HttpResponse("Missing jobOfferingId/userId", status_code=400)

        logging.info("POST /enrichment/runs job=%s user=%s enricherType=%s", job_id, user_id, enricher_type)

        # 1) DB create (Pending)
        run = create_run_db(job_id, user_id, enricher_type)

        try:
            # 2) Snapshot write
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

            # 3) (later) enqueue to Service Bus here

            # 4) Mark queued (once enqueue succeeds)
            mark_queued(run["runId"])
            run = svc.get_run(run["runId"])  # return canonical DB view

            return func.HttpResponse(json.dumps(run), mimetype="application/json", status_code=201)

        except Exception as e:
            logging.exception("POST /enrichment/runs failed after DB create")
            # Decide your policy: if snapshot/enqueue fails, mark Failed so it’s visible.
            mark_failed(run["runId"], "CreateRunFailed", str(e))
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)
