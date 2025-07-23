import logging
import azure.functions as func
import json
import os
import pyodbc

SQL_CONN_STR = os.getenv("SQLConnectionString")


def get_connection():
    return pyodbc.connect(SQL_CONN_STR)

# --- UPDATE ---
async def update_job(req: func.HttpRequest) -> func.HttpResponse:
    try:
        job_id = req.route_params.get("id")
        data = req.get_json()

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
        conn.commit()

        return func.HttpResponse("Job updated", status_code=200)
    except Exception as e:
        logging.exception("Error in update_job")
        return func.HttpResponse(f"Error: {str(e)}", status_code=500)
