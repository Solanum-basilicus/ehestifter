# enrichers/routes/enrichment_runs_post.py
import json
import logging
import azure.functions as func

from helpers.enrichment_snapshot import write_input_snapshot
from helpers.runs_create import create_run_db, mark_queued, dispatch_via_gateway
from domain.runs_service import RunsService  # keep for get_run normalization
from helpers.http_client import get_job_snapshot, get_user_cv_snapshot  # NEW

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

        logging.info(
            "POST /enrichment/runs job=%s user=%s enricherType=%s corr=%s",
            job_id, user_id, enricher_type, corr
        )

        # 1) DB create (Pending)
        run = create_run_db(job_id, user_id, enricher_type)

        # 2) Fetch inputs + write snapshot (any failure => leave Pending and return 201)
        try:
            job_snap = get_job_snapshot(job_id)
            cv_snap = get_user_cv_snapshot(user_id)

            job_title = job_snap.get("jobName")
            job_desc = job_snap.get("jobDescription")
            cv_text = cv_snap.get("CVPlainText")

            if not job_title or not isinstance(job_title, str):
                raise ValueError("Jobs snapshot missing/invalid 'jobName'")
            if not job_desc or not isinstance(job_desc, str):
                raise ValueError("Jobs snapshot missing/invalid 'jobDescription'")
            if not cv_text or not isinstance(cv_text, str):
                raise ValueError("Users snapshot missing/invalid 'CVPlainText'")

            snapshot = {
                "runId": run["runId"],
                "enricherType": run["enricherType"],
                "subjectKey": run["subjectKey"],
                "jobOfferingId": run["jobOfferingId"],
                "userId": run["userId"],
                "job": {"title": job_title, "description": job_desc},
                "cv": {"text": cv_text},
                "meta": {
                    "source": "core",
                    "version": 1,
                    # helpful breadcrumbs for debugging (optional)
                    "jobSnapshot": {"jobId": job_snap.get("jobId"), "companyName": job_snap.get("companyName")},
                    "cvSnapshot": {
                        "CVVersionId": cv_snap.get("CVVersionId"),
                        "LastUpdated": cv_snap.get("LastUpdated"),
                        "CVTextBlobPath": cv_snap.get("CVTextBlobPath"),
                    },
                },
            }

            blob_path = write_input_snapshot(run, snapshot)
            run["inputSnapshotBlobPath"] = blob_path

        except Exception as e:
            logging.exception("POST /enrichment/runs snapshot build failed (leaving Pending) corr=%s", corr)
            run = svc.get_run(run["runId"])
            return func.HttpResponse(json.dumps(run), mimetype="application/json", status_code=201)

        # 3) Dispatch to gateway (if this fails -> leave Pending; return 201; gateway sweep will pick it up)
        try:
            dispatch_via_gateway(run, run["inputSnapshotBlobPath"], corr=corr)
        except Exception:
            logging.exception("POST /enrichment/runs dispatch failed corr=%s", corr)
            run = svc.get_run(run["runId"])
            return func.HttpResponse(json.dumps(run), mimetype="application/json", status_code=201)

        # 4) Mark queued only after successful dispatch
        try:
            mark_queued(run["runId"])
            run = svc.get_run(run["runId"])
            return func.HttpResponse(json.dumps(run), mimetype="application/json", status_code=201)
        except Exception as e:
            # If this fails, we *did* enqueue. Better to return 500 and rely on later consistency check.
            logging.exception("POST /enrichment/runs mark_queued failed corr=%s", corr)
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)