import json
import logging
from typing import Iterable, List, Tuple

import azure.functions as func

from db import get_connection
from history import DatetimeEncoder
from ids import normalize_guid, is_guid

# Treat these as "final" (archived) statuses - exclude them from results.
# Adjust as you standardize your taxonomy.


FINAL_STATUSES = {
    "Rejected with Filled",
    "Rejected with Unfortunately",
    "Accepted Offer",
    "Turned down Offer",
}

def _parse_paging(req: func.HttpRequest) -> Tuple[int, int] | func.HttpResponse:
    try:
        limit = int(req.params.get("limit", 10))
        offset = int(req.params.get("offset", 0))
    except ValueError:
        return func.HttpResponse("Invalid 'limit' or 'offset'", status_code=400)

    if limit < 1 or limit > 50:
        return func.HttpResponse("'limit' must be between 1 and 50", status_code=400)
    if offset < 0:
        return func.HttpResponse("'offset' must be >= 0", status_code=400)

    return limit, offset


def _build_search_clause(q: str) -> Tuple[str, List[str]]:
    """
    Build a WHERE snippet and params to match all terms in q
    against Title, ExternalId, HiringCompanyName or PostingCompanyName.
    """
    if not q:
        return "", []

    # Split on whitespace; ignore empty terms
    terms = [t for t in q.strip().split() if t]
    params: List[str] = []
    clauses: List[str] = []
    for t in terms:
        like = f"%{t}%"
        # Each term must match at least one column
        clauses.append("(jo.Title LIKE ? OR jo.ExternalId LIKE ? OR jo.HiringCompanyName LIKE ? OR jo.PostingCompanyName LIKE ?)")
        params.extend([like, like, like, like])

    # All terms must match (AND across terms)
    return " AND ".join(clauses), params


def register(app: func.FunctionApp):

    @app.route(route="jobs/with-statuses", methods=["GET"])
    def list_jobs_with_statuses(req: func.HttpRequest) -> func.HttpResponse:
        """
        Query params:
          - userId  (required)  : internal user GUID (normalized by server)
          - q       (optional)  : search phrase; may be empty
          - limit   (optional)  : default 50
          - offset  (optional)  : default 0

        Returns: JSON array of jobs that have a non-final status for this user.
        Each item includes fields from JobOfferings, plus:
          - userStatus: the current status for this user
          - locations : array like in /jobs
        """
        logging.info("GET /jobs/with-statuses")
        try:
            user_id = (req.params.get("userId") or "").strip()
            if not user_id:
                return func.HttpResponse("Missing 'userId'", status_code=400)
            if not is_guid(user_id):
                return func.HttpResponse("Invalid 'userId' GUID", status_code=400)
            user_id = normalize_guid(user_id)

            paging = _parse_paging(req)
            if isinstance(paging, func.HttpResponse):
                return paging
            limit, offset = paging

            q = (req.params.get("q") or "").strip()
            search_clause, search_params = _build_search_clause(q)

            conn = get_connection()
            cur = conn.cursor()

            # We only want jobs that:
            #  - are not deleted
            #  - have a status row for this user
            #  - that status is NOT final
            #  - (optional) match the search
            # We also fetch the user's status to include it in the payload.
            final_placeholders = ",".join(["?"] * len(FINAL_STATUSES)) if FINAL_STATUSES else None
            status_filter = f"AND ujs.Status NOT IN ({final_placeholders})" if FINAL_STATUSES else ""

            where_parts: List[str] = [
                "jo.IsDeleted = 0",
                "ujs.UserId = ?",
            ]
            params: List = [user_id]

            if status_filter:
                params.extend(list(FINAL_STATUSES))
            if search_clause:
                where_parts.append(search_clause)
                params.extend(search_params)

            where_sql = " AND ".join(where_parts)

            # Main page of jobs + the user's status
            cur.execute(
                f"""
                SELECT
                    jo.Id,
                    jo.Title,
                    jo.ExternalId,
                    jo.FoundOn,
                    jo.HiringCompanyName,
                    jo.RemoteType,
                    jo.FirstSeenAt,
                    ujs.Status AS UserStatus
                FROM dbo.JobOfferings jo
                INNER JOIN dbo.UserJobStatus ujs
                    ON ujs.JobOfferingId = jo.Id
                WHERE {where_sql}
                ORDER BY jo.FirstSeenAt DESC
                OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
                """,
                params + [offset, limit]
            )
            rows = cur.fetchall()
            if not rows:
                return func.HttpResponse("[]", mimetype="application/json")

            cols = [c[0] for c in cur.description]
            jobs = [dict(zip(cols, r)) for r in rows]

            # Normalize GUIDs and rename status field for client
            for j in jobs:
                j["Id"] = normalize_guid(str(j["Id"]))
                j["userStatus"] = j.pop("UserStatus", "Unset")

            ids = [j["Id"] for j in jobs]

            # Fetch locations for the page of jobs
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
