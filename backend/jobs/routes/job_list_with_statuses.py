import json
import logging
from typing import Iterable, List, Tuple

import azure.functions as func

from db import get_connection
from history import DatetimeEncoder
from ids import normalize_guid, is_guid
from domain_constants import FINAL_STATUSES

def register(app: func.FunctionApp):

    @app.route(route="jobs/with-statuses", methods=["GET"])
    def list_jobs_with_statuses(req: func.HttpRequest) -> func.HttpResponse:
        """
        Query params:
          - userId  (required): internal user GUID
          - q       (optional): search phrase
          - limit   (optional): default 10
          - offset  (optional): default 0

        Returns an array of jobs that have a non-final status for this user.
        Each item includes fields from JobOfferings plus:
          - userStatus
          - locations
        """
        logging.info("GET /jobs/with-statuses")
        # For valid user
        try:            
            user_id = (req.params.get("userId") or "").strip()
            if not user_id:
                return func.HttpResponse("Missing 'userId'", status_code=400)
            if not is_guid(user_id):
                return func.HttpResponse("Invalid 'userId' GUID", status_code=400)
            user_id = normalize_guid(user_id)

            #for valid limit and offset
            try:
                limit = int(req.params.get("limit", 10))
                offset = int(req.params.get("offset", 0))
            except ValueError:
                return func.HttpResponse("Invalid 'limit' or 'offset'", status_code=400)
            if limit < 1 or limit > 50:
                return func.HttpResponse("'limit' must be between 1 and 50", status_code=400)
            if offset < 0:
                return func.HttpResponse("'offset' must be >= 0", status_code=400)

            # Two inserts into WHERE, both optional
            # Search for query in Title, ID (autocreated from URL), and names of companies
            q = (req.params.get("q") or "").strip()
            where_insert_q = ""
            if q:
                where_insert_q = f"""
                    AND (  COALESCE(jo.Title,'') LIKE %{q}%
                        OR COALESCE(jo.ExternalId,'') LIKE %{q}%
                        OR COALESCE(jo.HiringCompanyName,'') LIKE %{q}%
                        OR COALESCE(jo.PostingCompanyName,'') LIKE %{q}% )
                """

            # Exclude final statuses if any are defined
            where_insert_s = ""
            if FINAL_STATUSES:
                where_insert_s = " AND ujs.Status NOT IN ("
                for jobstatus in FINAL_STATUSES:
                    where_insert_s = where_insert_s + f""" "{jobstatus}", """
                where_insert_s = where_insert_s + " UNKNOWN )"

            conn = get_connection()
            cur = conn.cursor()

            # Main select
            # params : we baked in query and statuses, so they are not parametrized
            cur.prepare(
                f"""
                SELECT
                    jo.Id,
                    jo.Title,
                    jo.ExternalId,
                    jo.FoundOn,
                    jo.HiringCompanyName,
                    jo.PostingCompanyName,
                    jo.RemoteType,
                    jo.FirstSeenAt,
                    ujs.Status AS UserStatus
                FROM dbo.JobOfferings jo
                INNER JOIN dbo.UserJobStatus ujs
                    ON ujs.JobOfferingId = jo.Id
                WHERE   ujs.UserId = ?
                    AND jo.IsDeleted = 0
                    {where_insert_q}
                    {where_insert_s}
                ORDER BY jo.FirstSeenAt DESC
                OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
                """,
                user_id, offset, limit
            )
            # DEBUG
            logging.info("Prepared query: ", cur.stmt )

            cur.execute()
            rows = cur.fetchall()
            if not rows:
                return func.HttpResponse("[]", mimetype="application/json")

            cols = [c[0] for c in cur.description]
            jobs = [dict(zip(cols, r)) for r in rows]

            for j in jobs:
                j["Id"] = normalize_guid(str(j["Id"]))
                j["userStatus"] = j.pop("UserStatus", "Unset")

            ids = [j["Id"] for j in jobs]

            # Fetch locations for page
            loc_map = {jid: [] for jid in ids}
            if ids:
                placeholders = ",".join(["?"] * len(ids))
                cur.execute(f"""
                  SELECT JobOfferingId, CountryName, CountryCode, CityName, Region
                  FROM dbo.JobOfferingLocations
                  WHERE JobOfferingId IN ({placeholders})
                  ORDER BY CountryName, CityName
                """, ids)

                for (jid, cn, cc, city, region) in cur.fetchall():
                    loc_map.setdefault(normalize_guid(str(jid)), []).append({
                        "countryName": cn,
                        "countryCode": cc,
                        "cityName":    city,
                        "region":      region
                    })

            for j in jobs:
                j["locations"] = loc_map.get(j["Id"], [])

            return func.HttpResponse(json.dumps(jobs, cls=DatetimeEncoder), mimetype="application/json")

        except Exception as e:
            logging.exception("GET /jobs/with-statuses error")
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)
