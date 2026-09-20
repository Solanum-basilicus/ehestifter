"""Structured Open Opportunities query with optional Locations v2 eligibility."""

import json
import logging

import azure.functions as func

from helpers.db import get_connection
from helpers.history import DatetimeEncoder
from helpers.ids import normalize_guid
from helpers.location_eligibility import compile_eligibility_sql, validate_eligibility
from helpers.location_mode import active_location_model
from helpers.locations_v2 import load_locations_v2_catalog
from helpers.locations_v2_store import fetch_locations_v2_map


OPEN_MIN_COMPATIBILITY_SCORE = 5.0
MAX_LIMIT = 100


def _parse_body(req: func.HttpRequest) -> dict:
    try:
        body = req.get_json()
    except ValueError:
        raise ValueError("Invalid JSON")
    if body is None:
        return {}
    if not isinstance(body, dict):
        raise ValueError("Body must be a JSON object")
    unknown = set(body) - {"limit", "offset", "eligibility"}
    if unknown:
        raise ValueError(f"Unsupported field: {sorted(unknown)[0]}")
    return body


def _parse_page(body: dict) -> tuple[int, int]:
    limit = body.get("limit", 25)
    offset = body.get("offset", 0)
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1 or limit > MAX_LIMIT:
        raise ValueError(f"limit must be between 1 and {MAX_LIMIT}")
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise ValueError("offset must be a non-negative integer")
    return limit, offset


def register(app: func.FunctionApp):

    @app.route(route="jobs/open/query", methods=["POST"])
    def query_open_jobs(req: func.HttpRequest) -> func.HttpResponse:
        logging.info("POST /jobs/open/query")
        try:
            try:
                body = _parse_body(req)
                limit, offset = _parse_page(body)
                user_id_raw = (req.headers.get("x-user-id") or "").strip()
                if not user_id_raw:
                    raise ValueError("Missing user id (X-User-Id header)")
                user_id = normalize_guid(user_id_raw)
                if not user_id:
                    raise ValueError("X-User-Id must be a GUID")

                location_model = active_location_model()
                raw_eligibility = body.get("eligibility")
                eligibility = None
                catalog = None
                if location_model == "v2" and "eligibility" in body and raw_eligibility is not None:
                    catalog = load_locations_v2_catalog()
                    eligibility = validate_eligibility(catalog, raw_eligibility)
            except ValueError as exc:
                return func.HttpResponse(str(exc), status_code=400)
            except FileNotFoundError as exc:
                logging.exception("Locations v2 catalog is unavailable")
                return func.HttpResponse(str(exc), status_code=503)

            eligibility_applied = location_model == "v2" and eligibility is not None
            if eligibility_applied:
                eligibility_sql, eligibility_params = compile_eligibility_sql(catalog, eligibility)
            else:
                eligibility_sql, eligibility_params = "1=1", []
                if raw_eligibility is not None and location_model != "v2":
                    logging.info("Locations v2 eligibility ignored because active model is v1")

            conn = get_connection()
            cur = conn.cursor()

            from_sql = """
                FROM dbo.JobOfferings j
                LEFT JOIN dbo.UserJobStatus us
                  ON us.JobOfferingId = j.Id
                 AND us.UserId = ?
                INNER JOIN dbo.CompatibilityScores cs
                  ON cs.JobOfferingId = j.Id
                 AND cs.UserId = ?
                 AND cs.Score > ?
            """
            where_sql = f"""
                j.IsDeleted = 0
                AND us.Status IS NULL
                AND (j.CreatedByUserId IS NULL OR j.CreatedByUserId <> ?)
                AND ({eligibility_sql})
            """
            query_params = [
                user_id,
                user_id,
                OPEN_MIN_COMPATIBILITY_SCORE,
                user_id,
                *eligibility_params,
            ]

            cur.execute(f"SELECT COUNT(*) {from_sql} WHERE {where_sql}", query_params)
            total = int(cur.fetchone()[0] or 0)

            cur.execute(
                f"""
                SELECT
                    j.Id,
                    j.Title,
                    j.ExternalId,
                    j.FoundOn,
                    j.AtsVendor,
                    j.HiringCompanyName,
                    j.PostingCompanyName,
                    j.RemoteType,
                    j.FirstSeenAt,
                    j.CreatedAt,
                    j.UpdatedAt,
                    cs.Score AS CompatibilityScore
                {from_sql}
                WHERE {where_sql}
                ORDER BY j.CreatedAt DESC
                OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
                """,
                [*query_params, offset, limit],
            )
            rows = cur.fetchall()
            cols = [column[0] for column in cur.description]
            jobs = [dict(zip(cols, row)) for row in rows]

            job_ids = []
            for job in jobs:
                job["Id"] = normalize_guid(str(job["Id"]))
                job_ids.append(job["Id"])

            v1_map = {job_id: [] for job_id in job_ids}
            if job_ids:
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
                for row in cur.fetchall():
                    job_id = normalize_guid(str(row[0]))
                    v1_map.setdefault(job_id, []).append(
                        {
                            "countryName": row[1],
                            "countryCode": row[2],
                            "cityName": row[3],
                            "region": row[4],
                        }
                    )

            v2_map = fetch_locations_v2_map(cur, job_ids)
            for job in jobs:
                job["locations"] = v1_map.get(job["Id"], [])
                job["locationsV2"] = v2_map.get(job["Id"], [])

            payload = {
                "category": "open",
                "limit": limit,
                "offset": offset,
                "total": total,
                "activeLocationModel": location_model,
                "locationEligibilityApplied": eligibility_applied,
                "items": jobs,
            }
            return func.HttpResponse(
                json.dumps(payload, cls=DatetimeEncoder),
                mimetype="application/json",
                status_code=200,
            )
        except Exception as exc:
            logging.exception("POST /jobs/open/query error")
            return func.HttpResponse(f"Error: {str(exc)}", status_code=500)
