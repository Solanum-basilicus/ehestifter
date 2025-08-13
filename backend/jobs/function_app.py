import azure.functions as func
from datetime import datetime
import json
import logging
import os
import pyodbc
from validation import validate_job_payload

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


class DatetimeEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, datetime):
            return obj.isoformat()
        return super().default(obj)

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