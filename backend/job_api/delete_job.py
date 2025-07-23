import logging
import azure.functions as func
import json
import os
import pyodbc

SQL_CONN_STR = os.getenv("SQLConnectionString")


def get_connection():
    return pyodbc.connect(SQL_CONN_STR)

# --- DELETE ---
async def delete_job(req: func.HttpRequest) -> func.HttpResponse:
    try:
        job_id = req.route_params.get("id")

        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM JobOfferings WHERE Id = ?", job_id)
        conn.commit()

        return func.HttpResponse("Job deleted", status_code=200)
    except Exception as e:
        logging.exception("Error in delete_job")
        return func.HttpResponse(f"Error: {str(e)}", status_code=500)
