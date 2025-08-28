import json
import logging
import azure.functions as func
from helpers.db import get_connection
from helpers.auth import detect_actor
from helpers.ids import normalize_guid, is_guid
from helpers.history import insert_history

def register(app: func.FunctionApp):

    @app.route(route="jobs/{jobId}/history", methods=["POST"])
    def post_job_history(req: func.HttpRequest) -> func.HttpResponse:
        job_id_raw = req.route_params.get("jobId")
        if not is_guid(job_id_raw):
            return func.HttpResponse("Invalid jobId", status_code=400)
        job_id = normalize_guid(job_id_raw)
        conn = None
        try:
            body = req.get_json()
            if not isinstance(body, dict):
                return func.HttpResponse("Invalid JSON", status_code=400)

            action = body.get("action")
            if not action or not isinstance(action, str):
                return func.HttpResponse("Missing 'action'", status_code=400)

            details = body.get("details") or {}
            if not isinstance(details, dict):
                return func.HttpResponse("'details' must be an object", status_code=400)

            actor_type, actor_id = detect_actor(req)
            if body.get("actorType"):
                at = str(body["actorType"]).lower()
                if at not in ("system", "user"):
                    return func.HttpResponse("actorType must be 'system' or 'user'", status_code=400)
                actor_type = at
            if body.get("actorId"):
                aid = body["actorId"]
                if not (isinstance(aid, str) and is_guid(aid)):
                    return func.HttpResponse("actorId must be a GUID", status_code=400)

            conn = get_connection()
            cur = conn.cursor()
            cur.execute("SELECT 1 FROM dbo.JobOfferings WHERE Id = ?", job_id)
            if cur.fetchone() is None:
                return func.HttpResponse("Job not found", status_code=404)

            if "userId" in details and isinstance(details["userId"], str):
                details["userId"] = normalize_guid(details["userId"])

            insert_history(cur, job_id, action, details, actor_type, actor_id)
            conn.commit()
            return func.HttpResponse(json.dumps({"ok": True}), mimetype="application/json", status_code=200)

        except Exception as e:
            logging.exception("POST job history error")
            try:
                if conn: conn.rollback()
            except Exception:
                pass
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)
