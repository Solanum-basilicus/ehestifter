import azure.functions as func
from datetime import datetime
import json
import logging
import os
import pyodbc
from validation import validate_job_payload
import re
import uuid

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

# Endpoints

app = func.FunctionApp()

@app.route(route="HttpExample", auth_level=func.AuthLevel.ANONYMOUS)
def HttpExample(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('HttpExample processed a request.')

    name = req.params.get('name')
    if not name:
        try:
            req_body = req.get_json()
        except ValueError:
            pass
        else:
            name = req_body.get('name')

    if name:
        return func.HttpResponse(f"Hello, {name}!!! This HTTP triggered function executed successfully.")
    else:
        return func.HttpResponse(
             "This HTTP triggered function executed successfully. Pass a name in the query string or in the request body for a personalized response.",
             status_code=200
        )

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

        inserted_id = cursor.fetchone()[0]
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
    logging.info("PUT jobs processed a request with ID={job_id}")
    try:
        
        data = req.get_json()

        is_valid, error = validate_job_payload(data, for_update=True)
        if not is_valid:
            return func.HttpResponse(error, status_code=400)

        fields = [
            "Source", "ExternalId", "Url", "ApplyUrl", "HiringCompanyName",
            "PostingCompanyName", "Title", "Country", "Locality",
            "RemoteType", "Description", "PostedDate"
        ]

        updates = ", ".join(f"{f} = ?" for f in fields) + ", UpdatedAt = SYSDATETIME()"
        values = [data.get(f) for f in fields]

        conn = get_connection()
        cursor = conn.cursor()

        cursor.execute(f"UPDATE JobOfferings SET {updates} WHERE Id = ?", *values, job_id)
        
        if cursor.rowcount == 0:
            return func.HttpResponse("Job not found", status_code=404)        
        
        conn.commit()

        return func.HttpResponse("Job updated", status_code=200)

    except ValueError:
        return func.HttpResponse("Invalid JSON", status_code=400)        
    except Exception as e:
        logging.exception("PUT job: Error p10001")
        return func.HttpResponse(f"Error: {str(e)}", status_code=500)

@app.route(route="jobs/{id}", methods=["DELETE"])
def handle_delete_job(req: func.HttpRequest) -> func.HttpResponse:
    job_id = req.route_params.get("id")
    logging.info(f"DELETE jobs processed a request with ID={job_id}")
    try:
        conn = get_connection()
        cursor = conn.cursor()

        cursor.execute("UPDATE JobOfferings SET IsDeleted = 1, UpdatedAt = SYSDATETIME() WHERE Id = ?", job_id)
        rows_affected = cursor.rowcount
        conn.commit()
        
        if rows_affected == 0:
            return func.HttpResponse("No job found or already deleted", status_code=404)
        elif rows_affected > 1:
            logging.error(f"DELETE job: More than one row affected for ID={job_id}")
            return func.HttpResponse("Error: multiple jobs affected", status_code=500)

        return func.HttpResponse("Job marked as deleted", status_code=200)
    except Exception as e:
        logging.exception("DELETE job: Error: d10001")
        return func.HttpResponse(f"Error: {str(e)}", status_code=500)

@app.route(route="jobs/{jobId}/status", methods=["PUT"])
def put_job_status(req: func.HttpRequest) -> func.HttpResponse:
    try:
        user_id = get_current_user_id(req)
        job_id_raw = req.route_params.get("jobId")
        logging.info(f"PUT jobs/{job_id_raw}/status")
        try:
            if not is_guid(job_id_raw):
                return func.HttpResponse("Invalid jobId", status_code=400)
            job_id = normalize_guid(job_id_raw)

            user_id = get_current_user_id(req)

            try:
                payload = req.get_json()
            except ValueError:
                return func.HttpResponse("Invalid JSON", status_code=400)

            status = clean_status(payload.get("status"))

            conn = get_connection()
            cursor = conn.cursor()

            # Ensure the referenced JobOffering exists (optional but nice safety)
            cursor.execute("SELECT 1 FROM JobOfferings WHERE Id = ? AND IsDeleted = 0", job_id)
            if cursor.fetchone() is None:
                return func.HttpResponse("Job not found", status_code=404)

            # Upsert via MERGE; ignore Comment by design; set LastUpdated
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

            conn.commit()

            return func.HttpResponse(
                json.dumps({"jobId": job_id, "userId": user_id, "status": status}),
                mimetype="application/json",
                status_code=200
            )

        except ValueError as ve:
            return func.HttpResponse(str(ve), status_code=400)
        except Exception as e:
            logging.exception("PUT job status: Error js10001")
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)
    except UnauthorizedError as ue:
        return func.HttpResponse(str(ue), status_code=401)
    except ValueError as ve:
        return func.HttpResponse(str(ve), status_code=400)
    except Exception as e:
        logging.exception("PUT job status: Error js10001")
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
