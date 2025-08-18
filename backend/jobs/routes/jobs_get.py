import json
import logging
import azure.functions as func
from db import get_connection
from history import DatetimeEncoder

def register(app: func.FunctionApp):

    @app.route(route="jobs/{id}", methods=["GET"])
    def get_job(req: func.HttpRequest) -> func.HttpResponse:
        job_id = req.route_params.get("id")
        logging.info(f"GET /jobs/{job_id}")
        try:
            conn = get_connection()
            cur = conn.cursor()

            cur.execute("SELECT * FROM dbo.JobOfferings WHERE Id = ?", job_id)
            row = cur.fetchone()
            if not row:
                return func.HttpResponse("Not found", status_code=404)
            cols = [c[0] for c in cur.description]
            job = dict(zip(cols, row))

            cur.execute("""
              SELECT CountryName, CountryCode, CityName, Region
              FROM dbo.JobOfferingLocations
              WHERE JobOfferingId = ?
              ORDER BY CountryName, CityName
            """, job_id)
            job["locations"] = [
                {"countryName": r[0], "countryCode": r[1], "cityName": r[2], "region": r[3]}
                for r in cur.fetchall()
            ]

            return func.HttpResponse(json.dumps(job, cls=DatetimeEncoder), mimetype="application/json")
        except Exception as e:
            logging.exception("GET /jobs/{id} error")
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)
