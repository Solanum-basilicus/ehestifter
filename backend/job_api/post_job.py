import logging
import azure.functions as func
import json
import os
import pyodbc

SQL_CONN_STR = os.getenv("SQLConnectionString")


def get_connection():
    return pyodbc.connect(SQL_CONN_STR)


def post_job(req: func.HttpRequest) -> func.HttpResponse:
    logging.info("Processing POST job request.")
    try:
        data = req.get_json()

        required_fields = [
            "Source", "ExternalId", "Url", "HiringCompanyName", "Title", "Country"
        ]
        for field in required_fields:
            if field not in data:
                return func.HttpResponse(
                    f"Missing required field: {field}",
                    status_code=400
                )

        conn = get_connection()
        cursor = conn.cursor()

        cursor.execute("""
            INSERT INTO JobOfferings (
                Source, ExternalId, Url, ApplyUrl,
                HiringCompanyName, PostingCompanyName, Title,
                Country, Locality, RemoteType, Description,
                PostedDate, FirstSeenAt, CreatedAt
            )
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

        conn.commit()
        return func.HttpResponse("Job offering created", status_code=201)

    except ValueError:
        return func.HttpResponse("Invalid JSON", status_code=400)
    except Exception as e:
        logging.exception("Error during POST job")
        return func.HttpResponse(f"Server error: {str(e)}", status_code=500)
