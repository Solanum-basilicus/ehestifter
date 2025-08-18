import json
import logging
import azure.functions as func
from db import get_connection
from history import DatetimeEncoder

def register(app: func.FunctionApp):

    @app.route(route="jobs", methods=["GET"])
    def list_jobs(req: func.HttpRequest) -> func.HttpResponse:
        logging.info("GET /jobs")
        try:
            try:
                limit = int(req.params.get("limit", 50))
                offset = int(req.params.get("offset", 0))
            except ValueError:
                return func.HttpResponse("Invalid 'limit' or 'offset'", status_code=400)

            conn = get_connection()
            cur = conn.cursor()

            cur.execute("""
                SELECT Id, Title, HiringCompanyName, RemoteType, FirstSeenAt
                FROM dbo.JobOfferings
                WHERE IsDeleted = 0
                ORDER BY FirstSeenAt DESC
                OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
            """, (offset, limit))
            rows = cur.fetchall()
            cols = [c[0] for c in cur.description]
            jobs = [dict(zip(cols, r)) for r in rows]
            ids = [str(r[0]) for r in rows]

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
                    loc_map[str(jid)].append({
                        "countryName": cn,
                        "countryCode": cc,
                        "cityName": city,
                        "region": region
                    })

            for j in jobs:
                j["locations"] = loc_map.get(str(j["Id"]), [])

            return func.HttpResponse(json.dumps(jobs, cls=DatetimeEncoder), mimetype="application/json")

        except Exception as e:
            logging.exception("GET /jobs error")
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)
