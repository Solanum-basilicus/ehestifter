import json
import logging
import azure.functions as func
from db import get_connection
from auth import UnauthorizedError, get_current_user_id, is_guid, normalize_guid

def register(app: func.FunctionApp):

    @app.route(route="jobs/status", methods=["POST"])
    def post_job_statuses(req: func.HttpRequest) -> func.HttpResponse:
        try:
            user_id = get_current_user_id(req)
            try:
                body = req.get_json()
            except ValueError:
                return func.HttpResponse("Invalid JSON", status_code=400)

            if not isinstance(body, dict) or "jobIds" not in body:
                return func.HttpResponse("Body must include 'jobIds' array", status_code=400)

            raw_ids = body["jobIds"]
            if not isinstance(raw_ids, list):
                return func.HttpResponse("'jobIds' must be an array", status_code=400)

            job_ids = []
            for item in raw_ids:
                if not isinstance(item, str):
                    return func.HttpResponse("All jobIds must be strings", status_code=400)
                if not is_guid(item):
                    return func.HttpResponse(f"Invalid jobId GUID: {item}", status_code=400)
                job_ids.append(normalize_guid(item))

            seen = set()
            job_ids = [jid for jid in job_ids if not (jid in seen or seen.add(jid))]
            if len(job_ids) > 500:
                return func.HttpResponse("Too many jobIds (max 500)", status_code=400)

            if not job_ids:
                return func.HttpResponse(json.dumps({"userId": user_id, "statuses": {}}),
                                         mimetype="application/json", status_code=200)

            conn = get_connection()
            cur = conn.cursor()
            placeholders = ",".join(["?"] * len(job_ids))
            params = [user_id] + job_ids
            cur.execute(
                f"""
                SELECT JobOfferingId, Status
                FROM dbo.UserJobStatus
                WHERE UserId = ? AND JobOfferingId IN ({placeholders})
                """,
                params
            )
            found = {normalize_guid(str(r[0])): r[1] for r in cur.fetchall()}
            result = {jid: found.get(jid, "Unset") for jid in job_ids}
            return func.HttpResponse(json.dumps({"userId": user_id, "statuses": result}),
                                     mimetype="application/json", status_code=200)
        except UnauthorizedError as ue:
            return func.HttpResponse(str(ue), status_code=401)
        except Exception as e:
            logging.exception("POST job statuses error")
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)
