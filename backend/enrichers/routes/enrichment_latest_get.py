import json
import logging
import azure.functions as func
from domain.runs_service import RunsService


def _maybe_parse_json(value):
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        try:
            return json.loads(s)
        except Exception:
            # Don't 500 on bad legacy rows; expose as string
            return value
    return value


def _project_run_public(run: dict) -> dict:
    # Copy everything except the DB-ish JSON string fields
    out = {k: v for k, v in run.items() if k not in ("enrichmentAttributesJson")}

    # Add clean public fields
    out["result"] = _maybe_parse_json(run.get("resultJson"))
    out["enrichmentAttributes"] = _maybe_parse_json(run.get("enrichmentAttributesJson"))

    return out


def register(app: func.FunctionApp):
    svc = RunsService()

    @app.route(route="enrichment/subjects/{jobId:guid}/{userId:guid}/latest", methods=["GET"])
    def enrichment_latest(req: func.HttpRequest) -> func.HttpResponse:
        job_id = req.route_params.get("jobId")
        user_id = req.route_params.get("userId")
        enricher_type = req.params.get("enricherType") or "compatibility.v1"

        logging.info("GET latest enrichment: job=%s user=%s enricherType=%s", job_id, user_id, enricher_type)

        try:
            run = svc.get_latest(job_id, user_id, enricher_type)
            if not run:
                return func.HttpResponse("Not found", status_code=404)

            public_run = _project_run_public(run)
            return func.HttpResponse(json.dumps(public_run), mimetype="application/json", status_code=200)
        except Exception as e:
            logging.exception("GET latest enrichment failed")
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)
