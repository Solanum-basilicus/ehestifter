import logging
import azure.functions as func
import json
import os
import pyodbc

SQL_CONN_STR = os.getenv("SQLConnectionString")


def get_connection():
    return pyodbc.connect(SQL_CONN_STR)

async def list_jobs(req: func.HttpRequest) -> func.HttpResponse:
    try:
        conn = get_connection()
        cursor = conn.cursor()

        cursor.execute("SELECT Id, Title, HiringCompanyName, Country, Locality, RemoteType, FirstSeenAt FROM JobOfferings ORDER BY FirstSeenAt DESC")
        rows = cursor.fetchall()

        jobs = [dict(zip([column[0] for column in cursor.description], row)) for row in rows]
        return func.HttpResponse(json.dumps(jobs), mimetype="application/json")
    except Exception as e:
        logging.exception("Error in list_jobs")
        return func.HttpResponse(f"Error: {str(e)}", status_code=500)
