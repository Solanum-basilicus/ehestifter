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
from helpers.analytics import emit_jobs_event, correlation_id_from_request


def _analytics_provider_props_from_meta(meta: dict) -> dict:
    props = {}

    provider = (meta.get("provider") or "").strip()
    provider_tenant = (meta.get("providerTenant") or "").strip()

    if provider:
        props["provider"] = provider
    if provider_tenant:
        props["provider_tenant"] = provider_tenant

    return props


def _classify_create_failure(message: str) -> str:
    safe = (message or "").lower()

    if "externalid" in safe:
        return "missing_external_id"
    if "hiringcompanyname" in safe or "hiring company" in safe:
        return "missing_hiring_company"
    if "invalid json" in safe:
        return "invalid_json"
    if "required" in safe or "invalid" in safe or "deduce" in safe:
        return "validation_failed"

    return "unknown"

def create_job_record(req: func.HttpRequest, cur, data: dict, analytics_meta: dict | None = None) -> str:
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
    if analytics_meta is not None:
        analytics_meta["provider"] = provider
        analytics_meta["providerTenant"] = providerTenant

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
        if analytics_meta is not None:
            analytics_meta["dedupe_result"] = "created"        
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
        data = {}
        analytics_meta = {}

        actor_type, actor_id = detect_actor(req)
        user_id = actor_id if actor_type == "user" else None
        correlation_id = correlation_id_from_request(req)

        try:
            try:
                data = req.get_json()
            except ValueError:
                emit_jobs_event(
                    "Job Creation Failed",
                    req=req,
                    user_id=user_id,
                    correlation_id=correlation_id,
                    properties={
                        "failure_kind": "invalid_json",
                    },
                )
                return func.HttpResponse("Invalid JSON", status_code=400)

            conn = get_connection()
            cur = conn.cursor()

            try:
                job_id = create_job_record(req, cur, data, analytics_meta=analytics_meta)
            except ValueError as ve:
                failure_kind = _classify_create_failure(str(ve))
                props = {
                    "failure_kind": failure_kind,
                    **_analytics_provider_props_from_meta(analytics_meta),
                }

                emit_jobs_event(
                    "Job Creation Failed",
                    req=req,
                    user_id=user_id,
                    correlation_id=correlation_id,
                    properties=props,
                )
                return func.HttpResponse(str(ve), status_code=400)

            conn.commit()

            props = {
                "job_id": job_id,
                "creation_source": "manual_web",
                "dedupe_result": analytics_meta.get("dedupe_result"),
                **_analytics_provider_props_from_meta(analytics_meta),
            }

            emit_jobs_event(
                "Job Created",
                req=req,
                user_id=user_id,
                subject_type="job",
                subject_id=job_id,
                correlation_id=correlation_id,
                properties=props,
            )

            return func.HttpResponse(json.dumps({"id": job_id}), mimetype="application/json", status_code=201)

        except Exception as e:
            logging.exception("POST /jobs error")
            try:
                if conn:
                    conn.rollback()
            except Exception:
                pass

            props = {
                "failure_kind": "unknown",
                **_analytics_provider_props_from_meta(analytics_meta),
            }

            emit_jobs_event(
                "Job Creation Failed",
                req=req,
                user_id=user_id,
                correlation_id=correlation_id,
                properties=props,
            )

            return func.HttpResponse(f"Server error: {str(e)}", status_code=500)
            