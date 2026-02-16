# routes/internal_input_get.py
import json
import azure.functions as func

from helpers.enrichment_runs_db import get_input_snapshot_path
from helpers.blob_storage import enrichments_download_json


def _normalize_blob_path(p: str) -> str:
    # RunsService stores "enrichment/runs/{id}/input.json" but uploads to "runs/{id}/input.json"
    s = p.strip().lstrip("/")
    if s.startswith("enrichment/"):
        s = s[len("enrichment/"):]
    if s.startswith("enrichments/"):
        s = s[len("enrichments/"):]
    return s


def register(app: func.FunctionApp):
    @app.route(route="internal/enrichment/runs/{runId:guid}/input", methods=["GET"])
    def internal_input(req: func.HttpRequest) -> func.HttpResponse:
        run_id = req.route_params["runId"]

        path = get_input_snapshot_path(run_id)
        if not path:
            return func.HttpResponse(json.dumps({"code": "SNAPSHOT_MISSING"}), mimetype="application/json", status_code=409)

        blob_path = _normalize_blob_path(path)
        content = enrichments_download_json(blob_path)
        if content is None:
            return func.HttpResponse(json.dumps({"code": "BLOB_NOT_FOUND"}), mimetype="application/json", status_code=404)

        return func.HttpResponse(json.dumps(content), mimetype="application/json", status_code=200)
