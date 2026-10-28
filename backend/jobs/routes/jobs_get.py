import json
import logging
import azure.functions as func
from helpers.timing import step, catalog_call
from helpers.db import get_connection
from helpers.history import DatetimeEncoder
from helpers.ids import normalize_guid, normalize_guid_in_dict
from helpers.location_mode import active_location_model
from helpers.locations_v2 import load_locations_v2_catalog
from helpers.locations_v2_store import fetch_locations_v2, fetch_work_time_constraints_v2

def register(app: func.FunctionApp):

    @app.route(route="jobs/{id:guid}", methods=["GET"])
    def get_job(req: func.HttpRequest) -> func.HttpResponse:
        job_id = req.route_params.get("id")
        logging.info(f"GET /jobs/{job_id}")
        try:
            conn = get_connection()
            cur = conn.cursor()

            with step("job_row"):
                cur.execute("SELECT * FROM dbo.JobOfferings WHERE Id = ?", job_id)
                row = cur.fetchone()
                if not row:
                    return func.HttpResponse("Not found", status_code=404)
                cols = [c[0] for c in cur.description]
                job = dict(zip(cols, row))
                normalize_guid_in_dict(job, ["Id", "CreatedByUserId"])

            with step("legacy_locations"):
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
            location_model = active_location_model()
            catalog = catalog_call(load_locations_v2_catalog) if location_model == "v2" else None
            with step("locations_v2"):
                job["locationsV2"] = fetch_locations_v2(cur, job_id, catalog=catalog)
            with step("work_time"):
                job["workTimeConstraintsV2"] = fetch_work_time_constraints_v2(cur, job_id)
            job["activeLocationModel"] = location_model

            with step("serialize"):
                response = func.HttpResponse(json.dumps(job, cls=DatetimeEncoder), mimetype="application/json")
            return response
        except Exception as e:
            logging.exception("GET /jobs/{id} error")
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)
