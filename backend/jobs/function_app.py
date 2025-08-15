import azure.functions as func
from datetime import datetime
import json
import logging
import os
import pyodbc
from validation import validate_job_payload
import re
import uuid
from typing import Optional, Dict, Any
import base64

SQL_CONN_STR = os.getenv("SQLConnectionString")

def get_connection():
    try:
        return pyodbc.connect(SQL_CONN_STR, timeout=5)  # Optional: explicitly set timeout
    except pyodbc.InterfaceError as e:
        logging.error("SQL InterfaceError during connect: %s", e)
        raise Exception("Could not connect to the database: network issue or driver failure.")
    except pyodbc.OperationalError as e:
        logging.error("SQL OperationalError during connect: %s", e)
        raise Exception("Could not connect to the database: invalid credentials or timeout.")
    except Exception as e:
        logging.exception("Unhandled database connection error")
        raise Exception("Unexpected error while connecting to the database.")

# otherwise JSON fails to serialize
class DatetimeEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, datetime):
            return obj.isoformat()
        return super().default(obj)

# user job status helpers
GUID_REGEX = re.compile(
    r"^[{]?[0-9a-fA-F]{8}[-]?[0-9a-fA-F]{4}[-]?[0-9a-fA-F]{4}[-]?[0-9a-fA-F]{4}[-]?[0-9a-fA-F]{12}[}]?$"
)

def is_guid(s: str) -> bool:
    if not isinstance(s, str):
        return False
    if not GUID_REGEX.match(s):
        return False
    try:
        _ = uuid.UUID(s)
        return True
    except Exception:
        return False

def normalize_guid(s: str) -> str:
    # Return canonical 8-4-4-4-12 lowercase form
    return str(uuid.UUID(s))

class UnauthorizedError(Exception):
    pass

def get_current_user_id(req: func.HttpRequest) -> str:
    """
    Minimal, explicit auth context:
    - Expect X-User-Id header carrying the in-app user GUID (from your web core).
    - Validate and normalize to canonical GUID string.
    - Raise UnauthorizedError for missing/invalid values -> handled as 401.
    Later: replace with AAD B2C JWT parsing (prefer oid or sub) and keep the return contract.
    """
    user_id = req.headers.get("X-User-Id")
    if not user_id or not is_guid(user_id):
        raise UnauthorizedError("Missing or invalid X-User-Id")
    return normalize_guid(user_id)

def clean_status(value: str) -> str:
    if value is None:
        raise ValueError("Missing 'status'")
    if not isinstance(value, str):
        raise ValueError("Invalid 'status' type")
    s = " ".join(value.strip().split())  # trim + collapse whitespace
    if not s:
        raise ValueError("Empty 'status'")
    if len(s) > 100:
        raise ValueError("Status too long (max 100)")
    return s

# --- Job History related helpers ---
def insert_history(cursor, job_id: str, action: str, details_obj, actor_type: str, actor_id: Optional[str]):
    # ensure we can serialize nested datetimes, UUIDs, etc.
    payload = {"v": 1, "kind": action, "data": details_obj or {}}
    cursor.execute("""
        INSERT INTO dbo.JobOfferingHistory (JobOfferingId, ActorType, ActorId, Action, Details, Timestamp)
        VALUES (?, ?, ?, ?, ?, SYSDATETIME())
    """, (job_id, actor_type, actor_id, action, json.dumps(payload, cls=DatetimeEncoder)))

def detect_actor(req: func.HttpRequest) -> (str, Optional[str]):
    """
    Prefer user context when available; otherwise allow external/system writers to set X-Actor-Type: system.
    """
    try:
        uid = get_current_user_id(req)
        return "user", uid
    except UnauthorizedError:
        # external/system processes may not have a user; allow "system"
        at = (req.headers.get("X-Actor-Type") or "").lower()
        if at == "system":
            # optional: X-Actor-Id may be a GUID of a service principal or null
            aid = req.headers.get("X-Actor-Id")
            if aid and not is_guid(aid):
                aid = None
            return "system", aid
        # default to system with no id
        return "system", None

def make_history_cursor(ts: datetime, row_id: str) -> str:
    # keyset cursor: Timestamp + Id to break ties
    raw = f"{ts.isoformat()}|{row_id}"
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii")

def parse_history_cursor(cursor: str) -> (datetime, str):
    try:
        raw = base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8")
        ts_str, rid = raw.split("|", 1)
        return datetime.fromisoformat(ts_str), rid
    except Exception:
        raise ValueError("Invalid cursor")

# Endpoints

app = func.FunctionApp()


@app.route(route="pingX", methods=["GET"])
def pingX(req: func.HttpRequest) -> func.HttpResponse:
    logging.info("pingX processed a request.")
    return func.HttpResponse("pongX",status_code=200)

@app.route(route="jobs", methods=["POST"])
def handle_post_job(req: func.HttpRequest) -> func.HttpResponse:
    logging.info("POST jobs processed a request.")
    try:
        data = req.get_json()

        is_valid, error = validate_job_payload(data)
        if not is_valid:
            return func.HttpResponse(error, status_code=400)

        conn = get_connection()
        cursor = conn.cursor()

        actor_type, actor_id = detect_actor(req)

        # domain write
        cursor.execute("""
            INSERT INTO JobOfferings (
                Source, ExternalId, Url, ApplyUrl,
                HiringCompanyName, PostingCompanyName, Title,
                Country, Locality, RemoteType, Description,
                PostedDate, FirstSeenAt, CreatedAt
            )
            OUTPUT Inserted.Id
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, SYSDATETIME(), SYSDATETIME())
        """, (
            data["Source"],
            data["ExternalId"],
            data["Url"],
            data.get("ApplyUrl"),
            data["HiringCompanyName"],
            data.get("PostingCompanyName"),
            data["Title"],
            data["Country"],
            data.get("Locality"),
            data.get("RemoteType"),
            data.get("Description"),
            data.get("PostedDate")
        ))
        inserted_id = str(cursor.fetchone()[0])

        # history
        details = {"jobId": inserted_id}
        insert_history(cursor, inserted_id, "job_created", details, actor_type, actor_id)

        conn.commit()
        return func.HttpResponse(
            json.dumps({"id": str(inserted_id)}),
            mimetype="application/json",
            status_code=201
        )

    except ValueError:
        return func.HttpResponse("Invalid JSON", status_code=400)
    except Exception as e:
        logging.exception("POST jobs: Error p10001")
        try:
            conn.rollback()
        except Exception:
            pass
        return func.HttpResponse(f"Server error: {str(e)}", status_code=500)

@app.route(route="jobs", methods=["GET"])
def handle_list_jobs(req: func.HttpRequest) -> func.HttpResponse:
    logging.info("LIST jobs processed a request.")
    try:
        # Parse optional query parameters
        try:
            limit = int(req.params.get("limit", 50))
            offset = int(req.params.get("offset", 0))
        except ValueError:
            return func.HttpResponse("Invalid 'limit' or 'offset'", status_code=400)

        conn = get_connection()
        cursor = conn.cursor()

        cursor.execute(f"""
            SELECT Id, Title, HiringCompanyName, Country, Locality, RemoteType, FirstSeenAt 
            FROM JobOfferings 
            WHERE IsDeleted = 0 
            ORDER BY FirstSeenAt DESC
            OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
        """, (offset, limit))

        rows = cursor.fetchall()
        columns = [col[0] for col in cursor.description]
        jobs = [dict(zip(columns, row)) for row in rows]

        return func.HttpResponse(
            json.dumps(jobs, cls=DatetimeEncoder),
            mimetype="application/json"
        )

    except Exception as e:
        logging.exception("LIST jobs: Error l10001")
        return func.HttpResponse(f"Error: {str(e)}", status_code=500)

@app.route(route="jobs/{id}", methods=["GET"])
def handle_get_job(req: func.HttpRequest) -> func.HttpResponse:
    job_id = req.route_params.get("id")
    logging.info(f"GET job processed a request with ID={job_id}")

    try:
        conn = get_connection()
        cursor = conn.cursor()

        cursor.execute("SELECT * FROM JobOfferings WHERE Id = ?", job_id)
        row = cursor.fetchone()

        if not row:
            return func.HttpResponse("Not found", status_code=404)

        columns = [column[0] for column in cursor.description]
        job = dict(zip(columns, row))

        return func.HttpResponse(
            json.dumps(job, cls=DatetimeEncoder),
            mimetype="application/json"
        )

    except Exception as e:
        logging.exception("GET job: Error g10001")
        return func.HttpResponse(f"Error: {str(e)}", status_code=500)

@app.route(route="jobs/{id}", methods=["PUT"])
def handle_update_job(req: func.HttpRequest) -> func.HttpResponse:
    job_id = req.route_params.get("id")
    logging.info(f"PUT jobs processed a request with ID={job_id}")
    conn = None
    try:
        data = req.get_json()
        is_valid, error = validate_job_payload(data, for_update=True)
        if not is_valid:
            return func.HttpResponse(error, status_code=400)

        fields = [
            "Source","ExternalId","Url","ApplyUrl","HiringCompanyName",
            "PostingCompanyName","Title","Country","Locality",
            "RemoteType","Description","PostedDate"
        ]

        conn = get_connection()
        cursor = conn.cursor()
        actor_type, actor_id = detect_actor(req)

        # snapshot before
        cursor.execute("SELECT " + ",".join(fields) + " FROM JobOfferings WHERE Id = ?", job_id)
        row_before = cursor.fetchone()
        if not row_before:
            return func.HttpResponse("Job not found", status_code=404)
        before = dict(zip(fields, row_before))

        # domain write
        updates = ", ".join(f"{f} = ?" for f in fields) + ", UpdatedAt = SYSDATETIME()"
        values = [data.get(f) for f in fields]
        cursor.execute(f"UPDATE JobOfferings SET {updates} WHERE Id = ?", *values, job_id)
        if cursor.rowcount == 0:
            return func.HttpResponse("Job not found", status_code=404)

        # compute trimmed diff
        after = {f: data.get(f) for f in fields}
        changed = {}
        desc_changed = False

        for f in fields:
            if f == "Description":
                if before.get(f) != after.get(f):
                    desc_changed = True
                continue  # never include Description values
            if before.get(f) != after.get(f):
                changed[f] = {"from": before.get(f), "to": after.get(f)}

        if changed or desc_changed:
            details = {"changed": changed}
            if desc_changed:
                details["descriptionChanged"] = True
            insert_history(cursor, job_id, "job_updated", details, actor_type, actor_id)

        conn.commit()
        return func.HttpResponse("Job updated", status_code=200)

    except ValueError:
        return func.HttpResponse("Invalid JSON", status_code=400)
    except Exception as e:
        logging.exception("PUT job: Error p10001")
        try:
            if conn: conn.rollback()
        except Exception:
            pass
        return func.HttpResponse(f"Error: {str(e)}", status_code=500)

@app.route(route="jobs/{id}", methods=["DELETE"])
def handle_delete_job(req: func.HttpRequest) -> func.HttpResponse:
    job_id = req.route_params.get("id")
    logging.info(f"DELETE jobs processed a request with ID={job_id}")
    conn = None
    try:
        conn = get_connection()
        cursor = conn.cursor()
        actor_type, actor_id = detect_actor(req)

        cursor.execute("UPDATE JobOfferings SET IsDeleted = 1, UpdatedAt = SYSDATETIME() WHERE Id = ?", job_id)
        rows_affected = cursor.rowcount
        if rows_affected == 0:
            conn.rollback()
            return func.HttpResponse("No job found or already deleted", status_code=404)
        elif rows_affected > 1:
            conn.rollback()
            logging.error(f"DELETE job: More than one row affected for ID={job_id}")
            return func.HttpResponse("Error: multiple jobs affected", status_code=500)

        insert_history(cursor, job_id, "job_deleted", {"softDelete": True}, actor_type, actor_id)

        conn.commit()
        return func.HttpResponse("Job marked as deleted", status_code=200)
    except Exception as e:
        logging.exception("DELETE job: Error: d10001")
        try:
            if conn: conn.rollback()
        except Exception:
            pass
        return func.HttpResponse(f"Error: {str(e)}", status_code=500)

@app.route(route="jobs/{jobId}/status", methods=["PUT"])
def put_job_status(req: func.HttpRequest) -> func.HttpResponse:
    conn = None
    try:
        user_id = get_current_user_id(req)
        job_id_raw = req.route_params.get("jobId")
        logging.info(f"PUT jobs/{job_id_raw}/status")

        if not is_guid(job_id_raw):
            return func.HttpResponse("Invalid jobId", status_code=400)
        job_id = normalize_guid(job_id_raw)

        payload = req.get_json()
        status = clean_status(payload.get("status"))

        conn = get_connection()
        cursor = conn.cursor()

        # Ensure job exists
        cursor.execute("SELECT 1 FROM JobOfferings WHERE Id = ? AND IsDeleted = 0", job_id)
        if cursor.fetchone() is None:
            return func.HttpResponse("Job not found", status_code=404)

        # Read previous status (if any)
        cursor.execute("""
            SELECT Status FROM dbo.UserJobStatus
            WHERE JobOfferingId = ? AND UserId = ?
        """, (job_id, user_id))
        prev_row = cursor.fetchone()
        prev_status = prev_row[0] if prev_row else "Unset"

        # Upsert status
        cursor.execute("""
            MERGE dbo.UserJobStatus AS target
            USING (SELECT ? AS JobOfferingId, ? AS UserId) AS src
            ON target.JobOfferingId = src.JobOfferingId AND target.UserId = src.UserId
            WHEN MATCHED THEN
              UPDATE SET Status = ?, LastUpdated = SYSDATETIME()
            WHEN NOT MATCHED THEN
              INSERT (JobOfferingId, UserId, Status, LastUpdated)
              VALUES (src.JobOfferingId, src.UserId, ?, SYSDATETIME());
        """, (job_id, user_id, status, status))

        # History (actor: user)
        insert_history(
            cursor, job_id, "status_changed",
            {"userId": user_id, "from": prev_status, "to": status},
            "user", user_id
        )

        conn.commit()
        return func.HttpResponse(
            json.dumps({"jobId": job_id, "userId": user_id, "status": status}),
            mimetype="application/json",
            status_code=200
        )

    except UnauthorizedError as ue:
        return func.HttpResponse(str(ue), status_code=401)
    except ValueError as ve:
        return func.HttpResponse(str(ve), status_code=400)
    except Exception as e:
        logging.exception("PUT job status: Error js10001")
        try:
            if conn: conn.rollback()
        except Exception:
            pass
        return func.HttpResponse(f"Error: {str(e)}", status_code=500)


@app.route(route="jobs/status", methods=["POST"])
def post_job_statuses(req: func.HttpRequest) -> func.HttpResponse:
    """
    POST /api/jobs/status
    Body: { "jobIds": ["<guid1>", "<guid2>", ...] }
    Returns: { "userId": "...", "statuses": { "<jobId>": "<Status or Unset>", ... } }
    """
    try:
        user_id = get_current_user_id(req)
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

            # Validate and normalize GUIDs; reuse parse_job_ids_param for consistent behavior
            job_ids = []
            for item in raw_ids:
                if not isinstance(item, str):
                    return func.HttpResponse("All jobIds must be strings", status_code=400)
                # parse_job_ids_param expects a comma-separated string; we want per-item validation here
                if not is_guid(item):
                    return func.HttpResponse(f"Invalid jobId GUID: {item}", status_code=400)
                job_ids.append(normalize_guid(item))

            # De-duplicate while preserving order
            seen = set()
            job_ids = [jid for jid in job_ids if not (jid in seen or seen.add(jid))]

            # Guardrail to avoid excessively large IN() lists; tune as you like
            if len(job_ids) > 500:
                return func.HttpResponse("Too many jobIds (max 500)", status_code=400)

            if not job_ids:
                return func.HttpResponse(
                    json.dumps({"userId": user_id, "statuses": {}}),
                    mimetype="application/json",
                    status_code=200
                )

            conn = get_connection()
            cursor = conn.cursor()

            placeholders = ",".join(["?"] * len(job_ids))
            params = [user_id] + job_ids

            cursor.execute(
                f"""
                SELECT JobOfferingId, Status
                FROM dbo.UserJobStatus
                WHERE UserId = ? AND JobOfferingId IN ({placeholders})
                """,
                params
            )

            found = {normalize_guid(str(row[0])): row[1] for row in cursor.fetchall()}
            result = {jid: found.get(jid, "Unset") for jid in job_ids}

            return func.HttpResponse(
                json.dumps({"userId": user_id, "statuses": result}),
                mimetype="application/json",
                status_code=200
            )

        except Exception as e:
            logging.exception("POST job statuses: Error js20002")
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)
    except UnauthorizedError as ue:
        return func.HttpResponse(str(ue), status_code=401)
    except ValueError as ve:
        return func.HttpResponse(str(ve), status_code=400)
    except Exception as e:
        logging.exception("POST job statuses: Error js20002")
        return func.HttpResponse(f"Error: {str(e)}", status_code=500)

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

        # override actor if provided in body, else detect from headers
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
            actor_id = normalize_guid(aid)

        conn = get_connection()
        cursor = conn.cursor()

        # ensure job exists (optional but recommended)
        cursor.execute("SELECT 1 FROM JobOfferings WHERE Id = ?", job_id)
        if cursor.fetchone() is None:
            return func.HttpResponse("Job not found", status_code=404)

        insert_history(cursor, job_id, action, details, actor_type, actor_id)
        conn.commit()
        return func.HttpResponse(json.dumps({"ok": True}), mimetype="application/json", status_code=200)

    except ValueError:
        return func.HttpResponse("Invalid JSON", status_code=400)
    except Exception as e:
        logging.exception("POST job history: Error h10001")
        try:
            if conn: conn.rollback()
        except Exception:
            pass
        return func.HttpResponse(f"Error: {str(e)}", status_code=500)

@app.route(route="jobs/{jobId}/history", methods=["GET"])
def get_job_history(req: func.HttpRequest) -> func.HttpResponse:
    job_id_raw = req.route_params.get("jobId")
    if not is_guid(job_id_raw):
        return func.HttpResponse("Invalid jobId", status_code=400)
    job_id = normalize_guid(job_id_raw)

    # query params: limit (default 50, max 200), cursor (optional)
    try:
        limit = int(req.params.get("limit", 50))
    except ValueError:
        return func.HttpResponse("Invalid 'limit'", status_code=400)
    limit = max(1, min(limit, 200))

    cursor = req.params.get("cursor")
    after_ts = None
    after_id = None
    if cursor:
        try:
            after_ts, after_id = parse_history_cursor(cursor)
        except ValueError:
            return func.HttpResponse("Invalid cursor", status_code=400)

    conn = None
    try:
        conn = get_connection()
        cursor_db = conn.cursor()

        # ensure job exists (optional but consistent with other endpoints)
        cursor_db.execute("SELECT 1 FROM dbo.JobOfferings WHERE Id = ?", job_id)
        if cursor_db.fetchone() is None:
            return func.HttpResponse("Job not found", status_code=404)

        # Keyset pagination: order newest first; when cursor present, fetch items *older* than the cursor
        # Tie-break with Id for stable order
        if after_ts is None:
            cursor_db.execute("""
                SELECT Id, JobOfferingId, Timestamp, ActorType, ActorId, Action, Details
                FROM dbo.JobOfferingHistory
                WHERE JobOfferingId = ?
                ORDER BY Timestamp DESC, Id DESC
                OFFSET 0 ROWS FETCH NEXT ? ROWS ONLY
            """, (job_id, limit))
        else:
            cursor_db.execute("""
                SELECT Id, JobOfferingId, Timestamp, ActorType, ActorId, Action, Details
                FROM dbo.JobOfferingHistory
                WHERE JobOfferingId = ?
                  AND (Timestamp < ? OR (Timestamp = ? AND Id < ?))
                ORDER BY Timestamp DESC, Id DESC
                OFFSET 0 ROWS FETCH NEXT ? ROWS ONLY
            """, (job_id, after_ts, after_ts, after_id, limit))

        rows = cursor_db.fetchall()

        # shape response
        items = []
        next_cursor = None
        for r in rows:
            r_id = str(r[0])
            r_job = str(r[1])
            r_ts = r[2]
            actor_type = r[3]
            actor_id = str(r[4]) if r[4] is not None else None
            action = r[5]
            details_json = r[6]

            # ensure Details is valid JSON text; if NVARCHAR saved as text, keep as-is
            try:
                details_obj = json.loads(details_json) if isinstance(details_json, str) else details_json
            except Exception:
                details_obj = None  # tolerate bad history payloads

            items.append({
                "id": r_id,
                "jobId": r_job,
                "timestamp": r_ts.isoformat(),
                "actorType": actor_type,
                "actorId": actor_id,
                "kind": action,
                "data": details_obj.get("data") if isinstance(details_obj, dict) and "data" in details_obj else None,
                "v": details_obj.get("v") if isinstance(details_obj, dict) and "v" in details_obj else None
            })

        if rows:
            last_ts = rows[-1][2]
            last_id = str(rows[-1][0])
            next_cursor = make_history_cursor(last_ts, last_id)

        return func.HttpResponse(
            json.dumps({
                "items": items,
                "nextCursor": next_cursor
            }),
            mimetype="application/json",
            status_code=200
        )
    except Exception as e:
        logging.exception("GET job history: Error gh10001")
        return func.HttpResponse(f"Error: {str(e)}", status_code=500)
