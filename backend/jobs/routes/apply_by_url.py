import json
import logging
import re
import azure.functions as func

from helpers.db import get_connection
from helpers.auth import get_current_user_id
from helpers.validation import validate_job_payload
from helpers.url_helpers import deduce_from_url

# Reuse the business logic from your existing routes
from routes.jobs_create import create_job_record  # new helper we expose via diff
from routes.job_status_put import upsert_user_status  # new helper we expose via diff


def _normalize_url(u: str) -> str:
    """Conservative normalization before heuristics:
    - replace any '?' after the first one with '&'
    - strip URL fragment
    - collapse repeated '&'
    This is intentionally tiny and independent from deduce_from_url().
    """
    u = (u or "").strip()
    if not u:
        return u
    if u.count("?") > 1:
        first = u.find("?")
        u = u[:first + 1] + u[first + 1:].replace("?", "&")
    u = u.split("#", 1)[0]
    u = re.sub(r"&{2,}", "&", u)
    return u


def register(app: func.FunctionApp):

    @app.route(route="jobs/apply-by-url", methods=["POST"])
    def apply_by_url(req: func.HttpRequest) -> func.HttpResponse:
        logging.info("POST /jobs/apply-by-url")

        conn = None
        try:
            # Must be a real app user (bot passes X-User-Id)
            user_id = get_current_user_id(req)

            try:
                body = req.get_json()
            except ValueError:
                return func.HttpResponse("Invalid JSON", status_code=400)

            if not isinstance(body, dict):
                return func.HttpResponse("Body must be a JSON object", status_code=400)

            raw_url = body.get("url")
            if not isinstance(raw_url, str) or not raw_url.strip():
                return func.HttpResponse("Missing required field: url", status_code=400)

            url = _normalize_url(raw_url)
            desired_status = body.get("status") or "Applied"
            if not isinstance(desired_status, str) or not desired_status.strip():
                return func.HttpResponse("Missing or invalid 'status'", status_code=400)
            desired_status = " ".join(desired_status.strip().split())
            if len(desired_status) > 100:
                return func.HttpResponse("Status too long (max 100)", status_code=400)

            # Build creation payload using the same validation + heuristics as POST /jobs
            # We keep the payload minimal - your create_job_record() will handle idempotent insert.
            heur = deduce_from_url(url) or {}
            create_payload = {
                "url": url,
                # prefer explicit fields if caller passes them (future-proof),
                # otherwise reuse what your deducer provides:
                "foundOn": body.get("foundOn") or heur.get("foundOn"),
                "provider": body.get("provider") or heur.get("provider"),
                "providerTenant": body.get("providerTenant") or heur.get("providerTenant"),
                "externalId": body.get("externalId") or heur.get("externalId"),
                "hiringCompanyName": body.get("hiringCompanyName") or heur.get("hiringCompanyName"),
                "postingCompanyName": body.get("postingCompanyName"),
                "title": body.get("title"),
                "remoteType": body.get("remoteType") or "Unknown",
                "description": body.get("description"),
                "applyUrl": body.get("applyUrl"),
                "locations": body.get("locations") or [],
            }

            ok, msg = validate_job_payload(create_payload)
            if not ok:
                return func.HttpResponse(msg, status_code=400)

            # Create or get the job, then upsert user status — all in one transaction.
            conn = get_connection()
            cur = conn.cursor()

            job_id = create_job_record(req, cur, create_payload)
            upsert_user_status(cur, job_id, user_id, desired_status)

            # Fetch a few display fields for the response
            cur.execute("""
                SELECT Title, HiringCompanyName, Url
                FROM dbo.JobOfferings
                WHERE Id = ? AND IsDeleted = 0
            """, job_id)
            row = cur.fetchone()
            if not row:
                # Extremely unlikely if create succeeded; guard anyway
                title, company, link = "Unknown", "?", url
            else:
                title, company, link = row[0] or "Unknown", row[1] or "?", row[2] or url

            conn.commit()

            resp = {
                "jobId": job_id,
                "title": title,
                "company": company,
                "link": link,
                "status": desired_status,
            }
            return func.HttpResponse(json.dumps(resp), mimetype="application/json", status_code=200)

        except Exception:
            logging.exception("POST /jobs/apply-by-url error")
            try:
                if conn:
                    conn.rollback()
            except Exception:
                pass
            return func.HttpResponse("Server error", status_code=500)
