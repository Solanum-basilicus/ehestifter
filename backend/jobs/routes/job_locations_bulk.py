"""Return locations for a bounded set of jobs."""

import json
import logging

import azure.functions as func

from helpers.db import get_connection
from helpers.ids import is_guid, normalize_guid
from helpers.location_mode import active_location_model
from helpers.locations_v2 import load_locations_v2_catalog
from helpers.locations_v2_store import fetch_locations_v2_map


MAX_JOB_IDS = 500


def _parse_job_ids(req: func.HttpRequest) -> tuple[list[str] | None, str | None]:
    try:
        body = req.get_json()
    except ValueError:
        return None, "Invalid JSON"

    if not isinstance(body, dict) or "jobIds" not in body:
        return None, "Body must include 'jobIds' array"

    raw_ids = body["jobIds"]
    if not isinstance(raw_ids, list):
        return None, "'jobIds' must be an array"

    job_ids = []
    for item in raw_ids:
        if not isinstance(item, str):
            return None, "All jobIds must be strings"
        if not is_guid(item):
            return None, f"Invalid jobId GUID: {item}"
        job_ids.append(normalize_guid(item))

    seen = set()
    job_ids = [job_id for job_id in job_ids if not (job_id in seen or seen.add(job_id))]
    if len(job_ids) > MAX_JOB_IDS:
        return None, f"Too many jobIds (max {MAX_JOB_IDS})"

    return job_ids, None


def _empty_map(job_ids: list[str]) -> dict[str, list[dict]]:
    return {job_id: [] for job_id in job_ids}


def _fetch_locations_v1_map(cur, job_ids: list[str]) -> dict[str, list[dict]]:
    result = _empty_map(job_ids)
    if not job_ids:
        return result

    placeholders = ",".join(["?"] * len(job_ids))
    cur.execute(
        f"""
        SELECT JobOfferingId, CountryName, CountryCode, CityName, Region
        FROM dbo.JobOfferingLocations
        WHERE JobOfferingId IN ({placeholders})
        ORDER BY JobOfferingId, CountryName, CityName
        """,
        job_ids,
    )
    for job_id, country_name, country_code, city_name, region in cur.fetchall():
        key = normalize_guid(str(job_id))
        result.setdefault(key, []).append(
            {
                "countryName": country_name,
                "countryCode": country_code,
                "cityName": city_name,
                "region": region,
            }
        )
    return result


def register(app: func.FunctionApp):

    @app.route(route="jobs/locations", methods=["POST"])
    def post_job_locations(req: func.HttpRequest) -> func.HttpResponse:
        logging.info("POST /jobs/locations")
        try:
            job_ids, error = _parse_job_ids(req)
            if error:
                return func.HttpResponse(error, status_code=400)

            location_model = active_location_model()
            locations = _empty_map(job_ids)
            locations_v2 = _empty_map(job_ids)

            if job_ids:
                conn = get_connection()
                cur = conn.cursor()
                if location_model == "v2":
                    catalog = load_locations_v2_catalog()
                    locations_v2 = fetch_locations_v2_map(cur, job_ids, catalog=catalog)
                else:
                    locations = _fetch_locations_v1_map(cur, job_ids)

            payload = {
                "activeLocationModel": location_model,
                "locations": locations,
                "locationsV2": locations_v2,
            }
            return func.HttpResponse(
                json.dumps(payload),
                mimetype="application/json",
                status_code=200,
            )
        except Exception as exc:
            logging.exception("POST /jobs/locations error")
            return func.HttpResponse(f"Error: {str(exc)}", status_code=500)
