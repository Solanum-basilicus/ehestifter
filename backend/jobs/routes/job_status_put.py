import json
import logging
import azure.functions as func
from db import get_connection
from auth import UnauthorizedError, get_current_user_id
from ids import normalize_guid, is_guid
from history import insert_history
import uuid

def register(app: func.FunctionApp):

    @app.route(route="jobs/{jobId}/status", methods=["PUT"])
    def put_job_status(req: func.HttpRequest) -> func.HttpResponse:
        conn = None
        try:
            user_id = normalize_guid(get_current_user_id(req))
            job_id_raw = req.route_params.get("jobId")
            logging.info(f"PUT jobs/{job_id_raw}/status")

            if not is_guid(job_id_raw):
                return func.HttpResponse("Invalid jobId", status_code=400)
            job_id = normalize_guid(job_id_raw)

            payload = req.get_json()
            status = payload.get("status")
            if not isinstance(status, str) or not status.strip():
                return func.HttpResponse("Missing or invalid 'status'", status_code=400)
            status = " ".join(status.strip().split())
            if len(status) > 100:
                return func.HttpResponse("Status too long (max 100)", status_code=400)

            conn = get_connection()
            cur = conn.cursor()

            cur.execute("SELECT 1 FROM dbo.JobOfferings WHERE Id = ? AND IsDeleted = 0", job_id)
            if cur.fetchone() is None:
                return func.HttpResponse("Job not found", status_code=404)

            cur.execute("""
                SELECT Status FROM dbo.UserJobStatus
                WHERE JobOfferingId = ? AND UserId = ?
            """, (job_id, user_id))
            row = cur.fetchone()
            prev_status = row[0] if row else "Unset"

            cur.execute("""
                MERGE dbo.UserJobStatus AS target
                USING (SELECT ? AS JobOfferingId, ? AS UserId) AS src
                ON target.JobOfferingId = src.JobOfferingId AND target.UserId = src.UserId
                WHEN MATCHED THEN
                  UPDATE SET Status = ?, LastUpdated = SYSDATETIME()
                WHEN NOT MATCHED THEN
                  INSERT (JobOfferingId, UserId, Status, LastUpdated)
                  VALUES (src.JobOfferingId, src.UserId, ?, SYSDATETIME());
            """, (job_id, user_id, status, status))

            insert_history(cur, job_id, "status_changed",
                           {"userId": user_id, "from": prev_status, "to": status},
                           "user", user_id)

            conn.commit()
            return func.HttpResponse(
                json.dumps({"jobId": normalize_guid(job_id), "userId": normalize_guid(user_id), "status": status}),
                mimetype="application/json", status_code=200
            )

        except UnauthorizedError as ue:
            return func.HttpResponse(str(ue), status_code=401)
        except Exception as e:
            logging.exception("PUT job status error")
            try:
                if conn: conn.rollback()
            except Exception:
                pass
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)
