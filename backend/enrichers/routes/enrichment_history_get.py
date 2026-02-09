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
            return value
    return value


def _project_run_public(run: dict) -> dict:
    out = {k: v for k, v in run.items() if k not in ("resultJson", "enrichmentAttributesJson")}
    out["result"] = _maybe_parse_json(run.get("resultJson"))
    out["enrichmentAttributes"] = _maybe_parse_json(run.get("enrichmentAttributesJson"))
    return out


def register(app: func.FunctionApp):
    svc = RunsService()

    @app.route(route="enrichment/subjects/{jobId:guid}/{userId:guid}/history", methods=["GET"])
    def enrichment_history(req: func.HttpRequest) -> func.HttpResponse:
        job_id = req.route_params.get("jobId")
        user_id = req.route_params.get("userId")
        enricher_type = req.params.get("enricherType") or "compatibility.v1"
        limit = int(req.params.get("limit") or 50)
        offset = int(req.params.get("offset") or 0)

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
            public_items = [_project_run_public(it) for it in items]
            return func.HttpResponse(
                json.dumps({"items": public_items, "limit": limit, "offset": offset}),
                mimetype="application/json",
                status_code=200,
            )
        except Exception as e:
            logging.exception("GET enrichment history failed")
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)
