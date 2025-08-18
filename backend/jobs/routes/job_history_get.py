import json
import logging
import azure.functions as func
from db import get_connection
from ids import normalize_guid, is_guid
from history import make_history_cursor, parse_history_cursor

def register(app: func.FunctionApp):

    @app.route(route="jobs/{jobId}/history", methods=["GET"])
    def get_job_history(req: func.HttpRequest) -> func.HttpResponse:
        job_id_raw = req.route_params.get("jobId")
        if not is_guid(job_id_raw):
            return func.HttpResponse("Invalid jobId", status_code=400)
        job_id = normalize_guid(job_id_raw)

        try:
            limit = int(req.params.get("limit", 50))
        except ValueError:
            return func.HttpResponse("Invalid 'limit'", status_code=400)
            # clamp
        limit = max(1, min(limit, 200))

        cur_token = req.params.get("cursor")
        after_ts = after_id = None
        if cur_token:
            try:
                after_ts, after_id = parse_history_cursor(cur_token)
            except Exception:
                return func.HttpResponse("Invalid cursor", status_code=400)

        conn = None
        try:
            conn = get_connection()
            cur = conn.cursor()
            cur.execute("SELECT 1 FROM dbo.JobOfferings WHERE Id = ?", job_id)
            if cur.fetchone() is None:
                return func.HttpResponse("Job not found", status_code=404)

            if after_ts is None:
                cur.execute("""
                    SELECT Id, JobOfferingId, Timestamp, ActorType, ActorId, Action, Details
                    FROM dbo.JobOfferingHistory
                    WHERE JobOfferingId = ?
                    ORDER BY Timestamp DESC, Id DESC
                    OFFSET 0 ROWS FETCH NEXT ? ROWS ONLY
                """, (job_id, limit))
            else:
                cur.execute("""
                    SELECT Id, JobOfferingId, Timestamp, ActorType, ActorId, Action, Details
                    FROM dbo.JobOfferingHistory
                    WHERE JobOfferingId = ?
                      AND (Timestamp < ? OR (Timestamp = ? AND Id < ?))
                    ORDER BY Timestamp DESC, Id DESC
                    OFFSET 0 ROWS FETCH NEXT ? ROWS ONLY
                """, (job_id, after_ts, after_ts, after_id, limit))

            rows = cur.fetchall()
            items = []
            next_cursor = None
            for r in rows:
                rid = str(r[0]); rjob = str(r[1]); rts = r[2]
                at = r[3]; aid = str(r[4]) if r[4] is not None else None
                act = r[5]; details_json = r[6]
                try:
                    d = json.loads(details_json) if isinstance(details_json, str) else details_json
                except Exception:
                    d = None
                items.append({
                    "id": normalize_guid(rid), 
                    "jobId": normalize_guid(rjob),
                    "timestamp": rts.isoformat(),
                    "actorType": at, 
                    "actorId": normalize_guid(aid) if aid else None,
                    "kind": act,
                    "data": d.get("data") if isinstance(d, dict) and "data" in d else None,
                    "v": d.get("v") if isinstance(d, dict) and "v" in d else None
                })
            if rows:
                last_ts = rows[-1][2]; last_id = str(rows[-1][0])
                next_cursor = make_history_cursor(last_ts, last_id)

            return func.HttpResponse(json.dumps({"items": items, "nextCursor": next_cursor}),
                                     mimetype="application/json", status_code=200)

        except Exception as e:
            logging.exception("GET job history error")
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)
