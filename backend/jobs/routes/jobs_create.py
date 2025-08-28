import json
import logging
import azure.functions as func
import uuid
from helpers.db import get_connection
from helpers.auth import detect_actor
from helpers.ids import normalize_guid
from helpers.history import insert_history
from helpers.validation import validate_job_payload
from helpers.url_helpers import deduce_from_url

def create_job_record(req: func.HttpRequest, cur, data: dict) -> str:
    """
    Core create logic extracted so it can be reused (e.g., by /jobs/apply-by-url).
    Accepts an open cursor and DOES NOT commit. Returns normalized job_id (str, canonical GUID).
    """
    is_valid, error = validate_job_payload(data)
    if not is_valid:
        raise ValueError(error)

    url = data.get("url")
    heur = deduce_from_url(url) if url else {}
    foundOn = data.get("foundOn") or heur.get("foundOn") or "corporate-site"
    provider = data.get("provider") or heur.get("provider") or "corporate-site"
    providerTenant = data.get("providerTenant") or heur.get("providerTenant") or ""
    externalId = data.get("externalId") or heur.get("externalId")
    hiringCompanyName = data.get("hiringCompanyName") or heur.get("hiringCompanyName")
    postingCompanyName = data.get("postingCompanyName")
    title = data.get("title")
    remoteType = data.get("remoteType") or "Unknown"
    description = data.get("description")
    applyUrl = data.get("applyUrl")
    locations = data.get("locations") or []

    if not externalId:
        raise ValueError("Could not deduce externalId from url; please provide externalId")
    if not hiringCompanyName:
        raise ValueError("Could not deduce hiringCompanyName from url; please provide hiringCompanyName")

    actor_type, actor_id = detect_actor(req)

    # Idempotent insert (on unique violation, fetch existing)
    try:
        cur.execute("""
            INSERT INTO dbo.JobOfferings (
              FoundOn, Provider, ProviderTenant, ExternalId,
              Url, ApplyUrl,
              HiringCompanyName, PostingCompanyName,
              Title, RemoteType, Description,
              CreatedByUserId, CreatedByAgent,
              FirstSeenAt, CreatedAt
            )
            OUTPUT Inserted.Id
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, SYSDATETIME(), SYSDATETIME())
        """, (
            foundOn, provider, providerTenant, externalId,
            url, applyUrl,
            hiringCompanyName, postingCompanyName,
            title, remoteType, description,
            actor_id if actor_type == "user" else None,
            actor_type if actor_type == "system" else None
        ))
        job_id = str(cur.fetchone()[0])
    except Exception:
        cur.execute("""
          SELECT Id FROM dbo.JobOfferings
          WHERE IsDeleted = 0 AND Provider = ? AND ProviderTenant = ? AND ExternalId = ?
        """, (provider, providerTenant, externalId))
        row = cur.fetchone()
        if not row:
            raise
        job_id = str(row[0])

    if locations:
        cur.fast_executemany = True
        cur.executemany("""
            INSERT INTO dbo.JobOfferingLocations (JobOfferingId, CountryName, CountryCode, CityName, Region)
            VALUES (?, ?, ?, ?, ?)
        """, [(
                job_id,
                loc.get("countryName"),
                (loc.get("countryCode") or None),
                (loc.get("cityName") or None),
                (loc.get("region") or None),
        ) for loc in locations])

    insert_history(cur, job_id, "job_created", {"jobId": job_id}, actor_type, actor_id)
    return normalize_guid(str(job_id))


def register(app: func.FunctionApp):

    @app.route(route="jobs", methods=["POST"])
    def create_job(req: func.HttpRequest) -> func.HttpResponse:
        logging.info("POST /jobs")
        conn = None
        try:
            try:
                data = req.get_json()
            except ValueError:
                return func.HttpResponse("Invalid JSON", status_code=400)

            conn = get_connection()
            cur = conn.cursor()

            try:
                job_id = create_job_record(req, cur, data)
            except ValueError as ve:
                return func.HttpResponse(str(ve), status_code=400)

            conn.commit()
            return func.HttpResponse(json.dumps({"id": job_id}), mimetype="application/json", status_code=201)

        except Exception as e:
            logging.exception("POST /jobs error")
            try:
                if conn: conn.rollback()
            except Exception:
                pass
            return func.HttpResponse(f"Server error: {str(e)}", status_code=500)
