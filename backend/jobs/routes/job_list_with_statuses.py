import json
import logging
from typing import List, Tuple

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
            logging.info("User for /jobs/with-statuses is %s", user_id)

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
            # Build search clause and params (safe parameterization)
            q = (req.params.get("q") or "").strip()
            search_clause = ""
            search_params: List[str] = []
            if q:
                # Split on whitespace; require all terms to match at least one of the 4 fields
                terms = [t for t in q.split() if t]
                per_term = (
                    "("
                    "COALESCE(jo.Title,'') LIKE ? OR "
                    "COALESCE(jo.ExternalId,'') LIKE ? OR "
                    "COALESCE(jo.HiringCompanyName,'') LIKE ? OR "
                    "COALESCE(jo.PostingCompanyName,'') LIKE ?"
                    ")"
                )
                search_clause = " AND " + " AND ".join([per_term] * len(terms))
                for t in terms:
                    like = f"%{t}%"
                    search_params.extend([like, like, like, like])

            # Exclude final statuses if any are defined
            # Build NOT IN placeholders for final statuses (parameterized, deterministic order)
            status_clause = ""
            status_params: List[str] = []
            if FINAL_STATUSES:
                placeholders = ",".join(["?"] * len(FINAL_STATUSES))
                status_clause = f" AND ujs.Status NOT IN ({placeholders})"
                status_params = list(FINAL_STATUSES)

            conn = get_connection()
            cur = conn.cursor()

            # Main select
            # params : we baked in query and statuses, so they are not parametrized
            sql = f"""
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
                WHERE   ujs.UserId = CONVERT(uniqueidentifier, ?)
                    AND jo.IsDeleted = 0
                    {search_clause}
                    {status_clause}
                ORDER BY jo.FirstSeenAt DESC
                OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
            """

            params: List = [user_id] + search_params + status_params + [offset, limit]
            logging.info("SQL (raw): %s", sql)
            logging.info("SQL params: %s", params)

            cur.execute(sql, params)


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
