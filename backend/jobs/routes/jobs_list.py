import json
import logging
import azure.functions as func
from datetime import datetime, timedelta
from urllib.parse import urlparse, parse_qs
from helpers.db import get_connection
from helpers.history import DatetimeEncoder
from helpers.ids import normalize_guid
from helpers.domain_constants import FINAL_STATUSES


REMOTE_MAP = {
    "remote": "Remote",
    "onsite": "Onsite",
    "hybrid": "Hybrid",
}

VALID_CATEGORIES = {"my", "open", "all"}
VALID_SEARCH_FIELDS = {"title_company", "company", "title", "location", "description"}
VALID_SORTS = {
    "created_desc", "created_asc",
    "updated_desc", "updated_asc",
    "status_progression",
    "location_az",
    # "compat_desc"  # future
}

def _parse_multi(req: func.HttpRequest, name: str) -> list[str]:
    """Return multi-valued query parameter via repeated keys or comma-separated."""
    qs = parse_qs(urlparse(req.url).query)
    vals = qs.get(name, [])
    out: list[str] = []
    for v in vals:
        if isinstance(v, str) and "," in v:
            out.extend([x.strip() for x in v.split(",") if x.strip()])
        elif isinstance(v, str):
            out.append(v.strip())
    return [v for v in out if v]

def _parse_date(val: str | None) -> datetime | None:
    if not val:
        return None
    try:
        # Expect YYYY-MM-DD; treat as start of day in server TZ (SQL Server stores DATETIME2)
        return datetime.strptime(val, "%Y-%m-%d")
    except Exception:
        return None

def _require_user_if_needed(req: func.HttpRequest, category: str, ignore_status: list[str]) -> str | None:
    uid = (req.headers.get("x-user-id") or req.params.get("userId") or "").strip()
    if (category == "my") or ignore_status:
        return normalize_guid(uid) if uid else None
    return normalize_guid(uid) if uid else None

def _likeify(s: str) -> str:
    return f"%{s}%"









def register(app: func.FunctionApp):

    @app.route(route="jobs", methods=["GET"])
    def list_jobs(req: func.HttpRequest) -> func.HttpResponse:
        logging.info("GET /jobs")
        try:
            # ----------------------------
            # Parse & validate query
            # ----------------------------
            category = (req.params.get("category") or "my").strip().lower()
            if category not in VALID_CATEGORIES:
                return func.HttpResponse("Invalid 'category'", status_code=400)

            q = (req.params.get("q") or "").strip()
            search_field = (req.params.get("search_field") or "title_company").strip().lower()
            if search_field not in VALID_SEARCH_FIELDS:
                return func.HttpResponse("Invalid 'search_field'", status_code=400)

            try:
                limit = int(req.params.get("limit", 25))
                offset = int(req.params.get("offset", 0))
                if limit <= 0: limit = 25
                if offset < 0: offset = 0
            except ValueError:
                return func.HttpResponse("Invalid 'limit' or 'offset'", status_code=400)

            modes = [m.lower() for m in _parse_multi(req, "mode")]
            cities = _parse_multi(req, "city")
            countries = _parse_multi(req, "country")
            ignore_status = [s.strip().lower() for s in _parse_multi(req, "ignore_status")]

            date_kind = (req.params.get("date_kind") or "updated").strip().lower()
            if date_kind not in {"updated", "created"}:
                return func.HttpResponse("Invalid 'date_kind'", status_code=400)
            date_from = _parse_date(req.params.get("date_from"))
            date_to = _parse_date(req.params.get("date_to"))
            # Treat date_to as end-of-day inclusive if provided
            if date_to:
                date_to = date_to + timedelta(days=1)

            sort = (req.params.get("sort") or "created_desc").strip().lower()
            if sort not in VALID_SORTS:
                return func.HttpResponse("Invalid 'sort'", status_code=400)

            user_id = _require_user_if_needed(req, category, ignore_status)
            if category == "my" and not user_id:
                return func.HttpResponse("Missing user id (X-User-Id header) for category='my'", status_code=400)

            # ----------------------------
            # Dynamic SQL assembly
            # ----------------------------
            conn = get_connection()
            cur = conn.cursor()

            joins = []
            where = ["j.IsDeleted = 0"]
            params: list = []
            params_count: list = []  # same as params but used for COUNT query too

            # Join per-user status if user_id available (needed for ignore_status, updated date_kind, user status in payload)
            if user_id:
                joins.append("LEFT JOIN dbo.UserJobStatus us ON us.JobOfferingId = j.Id AND us.UserId = ?")
                params.append(user_id)
                params_count.append(user_id)

            # Category constraints
            if category == "my":
                # created by me OR I have a non-final status on it
                where.append("(j.CreatedByUserId = ? OR (us.Status IS NOT NULL AND LOWER(us.Status) NOT IN (" +
                             ",".join(["?"] * len(FINAL_STATUSES)) + ")))")
                params.append(user_id)
                params_count.append(user_id)
                for s in FINAL_STATUSES:
                    params.append(s)
                    params_count.append(s)
            elif category == "open":
                # No final status recorded by anyone for this job
                where.append("NOT EXISTS (SELECT 1 FROM dbo.UserJobStatus s WHERE s.JobOfferingId = j.Id AND LOWER(s.Status) IN (" +
                             ",".join(["?"] * len(FINAL_STATUSES)) + "))")
                for s in FINAL_STATUSES:
                    params.append(s)
                    params_count.append(s)
            # category 'all' adds nothing beyond IsDeleted = 0

            # Search
            if q:
                if search_field == "title_company":
                    where.append("(j.Title LIKE ? OR j.HiringCompanyName LIKE ? OR j.PostingCompanyName LIKE ?)")
                    like = _likeify(q)
                    params += [like, like, like]
                    params_count += [like, like, like]
                elif search_field == "company":
                    where.append("(j.HiringCompanyName LIKE ? OR j.PostingCompanyName LIKE ?)")
                    like = _likeify(q)
                    params += [like, like]
                    params_count += [like, like]
                elif search_field == "title":
                    where.append("j.Title LIKE ?")
                    like = _likeify(q)
                    params += [like]
                    params_count += [like]
                elif search_field == "location":
                    where.append("""EXISTS (
                        SELECT 1 FROM dbo.JobOfferingLocations lq
                        WHERE lq.JobOfferingId = j.Id
                          AND (lq.CityName LIKE ? OR lq.CountryName LIKE ?)
                    )""")
                    like = _likeify(q)
                    params += [like, like]
                    params_count += [like, like]
                elif search_field == "description":
                    where.append("j.Description LIKE ?")
                    like = _likeify(q)
                    params += [like]
                    params_count += [like]

            # Mode filter (RemoteType)
            if modes:
                norm_modes = [REMOTE_MAP.get(m, m).title() for m in modes]
                placeholders = ",".join(["?"] * len(norm_modes))
                where.append(f"j.RemoteType IN ({placeholders})")
                params += norm_modes
                params_count += norm_modes

            # Location filters via EXISTS to avoid row explosion
            if cities:
                placeholders = ",".join(["?"] * len(cities))
                where.append(f"""EXISTS (
                    SELECT 1 FROM dbo.JobOfferingLocations lc
                    WHERE lc.JobOfferingId = j.Id AND lc.CityName IN ({placeholders})
                )""")
                params += cities
                params_count += cities
            if countries:
                ccodes = [c for c in countries if len(c.strip()) == 2]
                cnames = [c for c in countries if len(c.strip()) != 2]
                parts = []
                if ccodes:
                    parts.append(f"lc.CountryCode IN ({','.join(['?']*len(ccodes))})")
                if cnames:
                    parts.append(f"lc.CountryName IN ({','.join(['?']*len(cnames))})")
                if parts:
                    where.append(f"""EXISTS (
                        SELECT 1 FROM dbo.JobOfferingLocations lc
                        WHERE lc.JobOfferingId = j.Id AND ({" OR ".join(parts)})
                    )""")
                    params += ccodes + cnames
                    params_count += ccodes + cnames

            # Reverse status filter - ignore specific statuses for THIS user
            if ignore_status:
                placeholders = ",".join(["?"] * len(ignore_status))
                # If there's no user status, it passes; if present and in ignore list, exclude.
                where.append(f"(us.Status IS NULL OR LOWER(us.Status) NOT IN ({placeholders}))")
                params += [s.lower() for s in ignore_status]
                params_count += [s.lower() for s in ignore_status]

            # Date filters
            if date_kind == "updated":
                # If user join present, include user status timestamp in updated metric; else fall back to job timestamps
                updated_expr = "COALESCE(us.LastUpdated, j.UpdatedAt, j.CreatedAt)"
                if date_from:
                    where.append(f"{updated_expr} >= ?")
                    params.append(date_from)
                    params_count.append(date_from)
                if date_to:
                    where.append(f"{updated_expr} < ?")
                    params.append(date_to)
                    params_count.append(date_to)
            else:  # created
                if date_from:
                    where.append("j.CreatedAt >= ?")
                    params.append(date_from)
                    params_count.append(date_from)
                if date_to:
                    where.append("j.CreatedAt < ?")
                    params.append(date_to)
                    params_count.append(date_to)

            where_sql = " AND ".join(where) if where else "1=1"
            join_sql = " ".join(joins)

            # Sort ORDER BY
            if sort == "created_desc":
                order_sql = "ORDER BY j.CreatedAt DESC"
            elif sort == "created_asc":
                order_sql = "ORDER BY j.CreatedAt ASC"
            elif sort == "updated_desc":
                order_sql = "ORDER BY COALESCE(us.LastUpdated, j.UpdatedAt, j.CreatedAt) DESC"
            elif sort == "updated_asc":
                order_sql = "ORDER BY COALESCE(us.LastUpdated, j.UpdatedAt, j.CreatedAt) ASC"
            elif sort == "location_az":
                # Sort by first alphabetical location string
                order_sql = """
                    ORDER BY (
                        SELECT TOP 1 CONCAT(COALESCE(l.CountryName,''),'|',COALESCE(l.CityName,''))
                        FROM dbo.JobOfferingLocations l
                        WHERE l.JobOfferingId = j.Id
                        ORDER BY l.CountryName, l.CityName
                    ) ASC, j.CreatedAt DESC
                """
            elif sort == "status_progression":
                # Weight by progression; rejected/closed lowest
                order_sql = """
                    ORDER BY
                      CASE LOWER(COALESCE(us.Status, ''))
                        WHEN 'offer' THEN 6
                        WHEN 'interview' THEN 5
                        WHEN 'screening planned' THEN 4
                        WHEN 'applied' THEN 3
                        WHEN '' THEN 2
                        ELSE 1
                      END DESC,
                      COALESCE(us.LastUpdated, j.UpdatedAt, j.CreatedAt) DESC
                """
            else:
                order_sql = "ORDER BY j.CreatedAt DESC"

            # ----------------------------
            # Total count
            # ----------------------------
            count_sql = f"""
                SELECT COUNT(*) 
                FROM dbo.JobOfferings j
                {join_sql}
                WHERE {where_sql}
            """
            cur.execute(count_sql, params_count)
            total = int(cur.fetchone()[0] or 0)

            # ----------------------------
            # Paged select
            # ----------------------------
            select_sql = f"""
                SELECT
                  j.Id, j.Title, j.ExternalId, j.FoundOn,
                  j.HiringCompanyName, j.PostingCompanyName,
                  j.RemoteType,
                  j.CreatedAt, j.UpdatedAt,
                  us.Status AS UserStatus,
                  us.LastUpdated AS UserStatusLastUpdated,
                  COALESCE(us.LastUpdated, j.UpdatedAt, j.CreatedAt) AS LastUpdateAt
                FROM dbo.JobOfferings j
                {join_sql}
                WHERE {where_sql}
                {order_sql}
                OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
            """
            params_select = params + [offset, limit]
            cur.execute(select_sql, params_select)
            rows = cur.fetchall()

            if not rows:
                payload = {
                    "category": category,
                    "limit": limit,
                    "offset": offset,
                    "total": total,
                    "sort": sort,
                    "items": []
                }
                return func.HttpResponse(json.dumps(payload, cls=DatetimeEncoder), mimetype="application/json")

            cols = [c[0] for c in cur.description]
            jobs = [dict(zip(cols, r)) for r in rows]

            # Normalize Ids on the wire (canonical lowercase)
            norm_ids = []
            for j in jobs:
                j["Id"] = normalize_guid(str(j["Id"]))
                norm_ids.append(j["Id"])

            # Fetch locations for selected IDs
            loc_map = {jid: [] for jid in norm_ids}
            if norm_ids:
                placeholders = ",".join(["?"] * len(norm_ids))
                cur.execute(f"""
                  SELECT JobOfferingId, CountryName, CountryCode, CityName, Region
                  FROM dbo.JobOfferingLocations
                  WHERE JobOfferingId IN ({placeholders})
                  ORDER BY CountryName, CityName
                """, [normalize_guid(x) for x in norm_ids])
                for (jid, cn, cc, city, region) in cur.fetchall():
                    jid_norm = normalize_guid(str(jid))
                    loc_map.setdefault(jid_norm, []).append({
                        "countryName": cn,
                        "countryCode": cc,
                        "cityName":    city,
                        "region":      region
                    })

            # Attach locations
            for j in jobs:
                j["locations"] = loc_map.get(j["Id"], [])

            payload = {
                "category": category,
                "limit": limit,
                "offset": offset,
                "total": total,
                "sort": sort,
                "items": jobs
            }
            return func.HttpResponse(json.dumps(payload, cls=DatetimeEncoder), mimetype="application/json")

        except Exception as e:
            logging.exception("GET /jobs error")
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)
