# Enrichment run creation. Failures use fixed diagnostic fields.
import json

import azure.functions as func

from helpers.timing import step, failed_stage, clear_failed_stage
from helpers.compatibility_diagnostics import (
    safe_correlation_id, log_failure, diagnostic_headers, internal_error_response,
)
from helpers.enrichment_snapshot import write_input_snapshot
from helpers.runs_create import create_run_db, mark_queued, dispatch_via_gateway
from domain.runs_service import RunsService
from helpers.snapshot_clients import get_job_snapshot, get_user_cv_snapshot
from helpers.analytics import emit_enrichers_event, source_surface_from_request


def register(app: func.FunctionApp):
    svc = RunsService()

    @app.route(route="enrichment/runs", methods=["POST"])
    def create_enrichment_run(req: func.HttpRequest) -> func.HttpResponse:
        try:
            body = req.get_json()
        except Exception:
            return func.HttpResponse("Invalid JSON body", status_code=400)
        if not isinstance(body, dict):
            return func.HttpResponse("Invalid JSON body", status_code=400)

        job_id = body.get("jobOfferingId") or body.get("jobId")
        user_id = body.get("userId")
        enricher_type = body.get("enricherType") or "compatibility.v1"
        request_mode = body.get("requestMode", "manual")
        if request_mode not in ("automatic", "manual"):
            return func.HttpResponse("Invalid requestMode", status_code=400)
        if not job_id or not user_id:
            return func.HttpResponse("Missing jobOfferingId/userId", status_code=400)

        corr = safe_correlation_id(req.headers)
        run_id = None
        try:
            # Create or reuse the run in the Enrichers domain.
            with step("run_create"):
                run = create_run_db(job_id, user_id, enricher_type, request_mode=request_mode)
            run_id = run["runId"]
            decision = run["decision"]
            if decision != "created":
                with step("run_readback"):
                    existing = svc.get_run(run_id)
                existing["decision"] = decision
                return func.HttpResponse(
                    json.dumps(existing), mimetype="application/json", status_code=200,
                )

            source_surface = source_surface_from_request(req)
            if source_surface == "web":
                with step("analytics"):
                    emit_enrichers_event(
                        "Compatibility Requested",
                        user_id=user_id,
                        source_surface=source_surface,
                        subject_type="enrichment_run",
                        subject_id=run_id,
                        correlation_id=corr,
                        properties={
                            "job_id": run["jobOfferingId"],
                            "run_id": run_id,
                            "enricher_type": run["enricherType"],
                        },
                    )

            # A snapshot error leaves the new run Pending.
            try:
                with step("job_snapshot"):
                    job_snap = get_job_snapshot(job_id)
                with step("cv_snapshot"):
                    cv_snap = get_user_cv_snapshot(user_id)

                with step("snapshot_validate"):
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
                        "runId": run_id,
                        "enricherType": run["enricherType"],
                        "subjectKey": run["subjectKey"],
                        "jobOfferingId": run["jobOfferingId"],
                        "userId": run["userId"],
                        "job": {"title": job_title, "description": job_desc},
                        "cv": {"text": cv_text},
                        "meta": {
                            "source": "core",
                            "version": 1,
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
            except Exception as exc:
                diagnostic = log_failure(failed_stage("snapshot_validate"), exc, corr, run_id)
                clear_failed_stage()
                with step("run_readback"):
                    run = svc.get_run(run_id)
                run["decision"] = decision
                return func.HttpResponse(
                    json.dumps(run), mimetype="application/json", status_code=201,
                    headers=diagnostic_headers(diagnostic),
                )

            # A dispatch error also leaves the new run Pending.
            try:
                with step("gateway_dispatch"):
                    dispatch_via_gateway(run, run["inputSnapshotBlobPath"], corr=corr)
            except Exception as exc:
                diagnostic = log_failure(failed_stage("gateway_dispatch"), exc, corr, run_id)
                clear_failed_stage()
                with step("run_readback"):
                    run = svc.get_run(run_id)
                run["decision"] = decision
                return func.HttpResponse(
                    json.dumps(run), mimetype="application/json", status_code=201,
                    headers=diagnostic_headers(diagnostic),
                )

            # A failure after dispatch is ambiguous. Do not dispatch again here.
            with step("mark_queued"):
                mark_queued(run_id)
            with step("run_readback"):
                run = svc.get_run(run_id)
            run["decision"] = decision
            return func.HttpResponse(
                json.dumps(run), mimetype="application/json", status_code=201,
            )
        except Exception as exc:
            diagnostic = log_failure(failed_stage("run_create"), exc, corr, run_id)
            return internal_error_response(diagnostic)
