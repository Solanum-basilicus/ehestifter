import logging
import azure.functions as func
import json
import os
import pyodbc

SQL_CONN_STR = os.getenv("SQLConnectionString")


def get_connection():
    return pyodbc.connect(SQL_CONN_STR)

async def get_job(req: func.HttpRequest) -> func.HttpResponse:
    try:
        job_id = req.route_params.get("id")
        conn = get_connection()
        cursor = conn.cursor()

        cursor.execute("SELECT * FROM JobOfferings WHERE Id = ?", job_id)
        row = cursor.fetchone()

        if not row:
            return func.HttpResponse("Not found", status_code=404)

        job = dict(zip([column[0] for column in cursor.description], row))
        return func.HttpResponse(json.dumps(job), mimetype="application/json")
    except Exception as e:
        logging.exception("Error in get_job")
        return func.HttpResponse(f"Error: {str(e)}", status_code=500)