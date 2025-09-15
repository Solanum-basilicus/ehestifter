import json
import logging
from datetime import datetime, timedelta
from typing import Optional

import azure.functions as func

from helpers.db import get_connection
from helpers.auth import UnauthorizedError, get_current_user_id
from helpers.ids import normalize_guid


ISO_LAYOUTS = [
    "%Y-%m-%d",
    "%Y-%m-%dT%H:%M",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%dT%H:%M:%S.%f",
]

def _parse_iso_dt(value: str) -> Optional[datetime]:
    if not isinstance(value, str) or not value.strip():
        return None
    s = value.strip()
    # Normalize trailing 'Z' to UTC if present, but we keep naive timestamps throughout
    if s.endswith("Z"):
        s = s[:-1]
    for fmt in ISO_LAYOUTS:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _parse_bool(value: Optional[str]) -> bool:
    if value is None:
        return False
    v = value.strip().lower()
    return v in ("1", "true", "yes", "y", "on")


def _extract_status(action: Optional[str], details: Optional[str]) -> Optional[str]:
    """
    Supports:
      - action like 'status:applied'
      - action in {'status-changed','status_changed'} with Details JSON
        * Either raw {"to":"applied"} / {"status":"applied"}
        * Or wrapped {"v":1,"kind":"status_changed","data":{...}}
    """
    if not action:
        return None

    # Simple "status:<value>" form
    if action.startswith("status:") and len(action) > 7:
        return action[7:]

    # Generic forms: hyphen or underscore
    if action in ("status-changed", "status_changed") and details:
        try:
            d = json.loads(details)
            if isinstance(d, dict):
                # Unwrapped (raw) variant
                if "to" in d and isinstance(d["to"], str):
                    return d["to"]
                if "status" in d and isinstance(d["status"], str):
                    return d["status"]

                # Wrapped variant per your insert_history()
                # {"v":1,"kind":"status_changed","data":{"userId":...,"from":"X","to":"Y"}}
                data = d.get("data")
                if isinstance(data, dict):
                    if "to" in data and isinstance(data["to"], str):
                        return data["to"]
                    if "status" in data and isinstance(data["status"], str):
                        return data["status"]
        except Exception:
            pass

    return None


def register(app: func.FunctionApp):

    @app.route(route="jobs/reports/status", methods=["GET"])
    def get_user_status_changes(req: func.HttpRequest) -> func.HttpResponse:
        """
        Query params:
          - start: required ISO8601 date/datetime (e.g., 2025-08-01 or 2025-08-01T10:00)
          - end: optional ISO8601; if omitted -> 'now'
          - aggregate: optional bool; if true -> group by job with statuses list

        Constraints:
          - (end - start) must be <= 6 months (~184 days)
          - Sorted by ascending timestamp
        """
        try:
            user_id = get_current_user_id(req)

            start_raw = req.params.get("start")
            end_raw = req.params.get("end")
            aggregate_raw = req.params.get("aggregate")

            start_dt = _parse_iso_dt(start_raw) if start_raw else None
            if not start_dt:
                return func.HttpResponse("Query param 'start' is required and must be ISO date/datetime", status_code=400)

            end_dt = _parse_iso_dt(end_raw) if end_raw else datetime.utcnow()

            if end_dt < start_dt:
                return func.HttpResponse("'end' must be greater than or equal to 'start'", status_code=400)

            if (end_dt - start_dt) > timedelta(days=184):
                return func.HttpResponse("Interval must be 6 months or less", status_code=400)

            aggregate = _parse_bool(aggregate_raw)

            conn = get_connection()
            cur = conn.cursor()

            # We pull all history rows for the user in the window where action denotes a user status change.
            # Action filter covers both styles described above.
            cur.execute(
                """
                SELECT
                    j.Id,
                    ISNULL(j.Title, N'') AS Title,
                    ISNULL(j.PostingCompanyName, N'') AS PostingCompanyName,
                    ISNULL(j.HiringCompanyName, N'') AS HiringCompanyName,
                    ISNULL(j.Url, N'') AS Url,
                    h.Timestamp,
                    ISNULL(h.Action, N'') AS Action,
                    ISNULL(h.Details, N'') AS Details
                FROM dbo.JobOfferingHistory h
                INNER JOIN dbo.JobOfferings j ON j.Id = h.JobOfferingId
                WHERE
                    h.ActorType = N'user'
                    AND h.ActorId = ?
                    AND h.Timestamp >= ?
                    AND h.Timestamp <= ?
                    AND (
                        h.Action = N'status_changed'
                        OR h.Action LIKE N'status:%'
                    )
                ORDER BY h.Timestamp ASC
                """,
                (user_id, start_dt, end_dt)
            )

            rows = cur.fetchall()

            if not aggregate:
                items = []
                for r in rows:
                    job_id, title, posting_co, hiring_co, url, ts, action, details = r
                    status = _extract_status(action, details) or ""
                    items.append({
                        "jobId": normalize_guid(job_id),
                        "jobTitle": title,
                        "postingCompanyName": posting_co,
                        "hiringCompanyName": hiring_co,
                        "url": url,
                        "status": status,
                        "timestamp": ts.isoformat()
                    })

                payload = {
                    "userId": normalize_guid(user_id),
                    "aggregate": False,
                    "start": start_dt.isoformat(),
                    "end": end_dt.isoformat(),
                    "items": items
                }
                return func.HttpResponse(json.dumps(payload), mimetype="application/json", status_code=200)

            # aggregate == True
            by_job = {}
            for r in rows:
                job_id, title, posting_co, hiring_co, url, ts, action, details = r
                status = _extract_status(action, details) or ""
                key = normalize_guid(job_id)
                if key not in by_job:
                    by_job[key] = {
                        "jobId": key,
                        "jobTitle": title,
                        "postingCompanyName": posting_co,
                        "hiringCompanyName": hiring_co,
                        "url": url,
                        "statuses": []  # list of {status, timestamp}
                    }
                by_job[key]["statuses"].append({
                    "status": status,
                    "timestamp": ts.isoformat()
                })

            # Ensure statuses per job are sorted (query already sorted, but keep it explicit)
            for v in by_job.values():
                v["statuses"].sort(key=lambda x: x["timestamp"])

            payload = {
                "userId": normalize_guid(user_id),
                "aggregate": True,
                "start": start_dt.isoformat(),
                "end": end_dt.isoformat(),
                "items": list(by_job.values())
            }
            return func.HttpResponse(json.dumps(payload), mimetype="application/json", status_code=200)

        except UnauthorizedError as ue:
            return func.HttpResponse(str(ue), status_code=401)
        except Exception as e:
            logging.exception("GET user status changes report error")
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)
