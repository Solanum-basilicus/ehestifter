import json
import logging
import azure.functions as func
import uuid
import pyodbc
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

_JOB_IDENTITY_UNIQUE_INDEX = "UX_JobOfferings_ProviderTenantExternalId"


def _is_job_identity_duplicate(exc: Exception) -> bool:
    """
    Return True only for the canonical JobOfferings identity unique-index
    violation.

    SQL Server commonly reports duplicate keys as error 2601 or 2627 with
    SQLSTATE 23000.
    """
    if not isinstance(exc, pyodbc.IntegrityError):
        return False

    sqlstate = str(exc.args[0]) if exc.args else ""
    message = " ".join(str(arg) for arg in exc.args)

    return (
        sqlstate == "23000"
        and ("2601" in message or "2627" in message)
        and _JOB_IDENTITY_UNIQUE_INDEX in message
    )


def _normalize_unique_locations(locations: list[dict]) -> list[tuple]:
    """
    Normalize and deduplicate locations according to the database uniqueness
    model: JobOfferingId + CountryName + nullable CityName.

    CountryCode and Region are metadata, not identity fields.
    """
    normalized = []
    seen = set()

    for loc in locations:
        country_name = loc["countryName"].strip()

        country_code = (loc.get("countryCode") or "").strip().upper() or None
        city_name = (loc.get("cityName") or "").strip() or None
        region = (loc.get("region") or "").strip() or None

        key = (
            country_name.casefold(),
            city_name.casefold() if city_name is not None else None,
        )

        if key in seen:
            continue

        seen.add(key)
        normalized.append(
            (
                country_name,
                country_code,
                city_name,
                region,
            )
        )

    return normalized


def _insert_locations_idempotently(cur, job_id: str, locations: list[dict]) -> None:
    """
    Append locations that do not already exist.

    UPDLOCK + HOLDLOCK prevents two concurrent transactions from both deciding
    that the same location is absent.
    """
    for country_name, country_code, city_name, region in _normalize_unique_locations(
        locations
    ):
        if city_name is None:
            cur.execute(
                """
                INSERT INTO dbo.JobOfferingLocations (
                    JobOfferingId,
                    CountryName,
                    CountryCode,
                    CityName,
                    Region
                )
                SELECT ?, ?, ?, NULL, ?
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM dbo.JobOfferingLocations WITH (UPDLOCK, HOLDLOCK)
                    WHERE JobOfferingId = ?
                      AND CountryName = ?
                      AND CityName IS NULL
                )
                """,
                (
                    job_id,
                    country_name,
                    country_code,
                    region,
                    job_id,
                    country_name,
                ),
            )
        else:
            cur.execute(
                """
                INSERT INTO dbo.JobOfferingLocations (
                    JobOfferingId,
                    CountryName,
                    CountryCode,
                    CityName,
                    Region
                )
                SELECT ?, ?, ?, ?, ?
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM dbo.JobOfferingLocations WITH (UPDLOCK, HOLDLOCK)
                    WHERE JobOfferingId = ?
                      AND CountryName = ?
                      AND CityName = ?
                )
                """,
                (
                    job_id,
                    country_name,
                    country_code,
                    city_name,
                    region,
                    job_id,
                    country_name,
                    city_name,
                ),
            )




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
        analytics_meta["foundOn"] = foundOn

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
    except pyodbc.IntegrityError as exc:
        if not _is_job_identity_duplicate(exc):
            raise

        cur.execute(
            """
            SELECT Id
            FROM dbo.JobOfferings
            WHERE IsDeleted = 0
            AND Provider = ?
            AND ProviderTenant = ?
            AND ExternalId = ?
            """,
            (provider, providerTenant, externalId),
        )

        row = cur.fetchone()
        if not row:
            # Defensive: the reported identity collision must resolve to a row.
            raise

        job_id = str(row[0])

        if analytics_meta is not None:
            analytics_meta["dedupe_result"] = "existing"

    if locations:
        _insert_locations_idempotently(cur, job_id, locations)

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
            