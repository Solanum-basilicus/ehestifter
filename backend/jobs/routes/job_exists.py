# routes/job_exists.py
import json
import logging
import azure.functions as func

from helpers.db import get_connection
from helpers.ids import normalize_guid
from helpers.url_helpers import deduce_from_url


def _find_job_id(cur, provider: str, providerTenant: str, externalId: str):
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
    return normalize_guid(str(row[0])) if row else None


def _identity_from_request(req: func.HttpRequest) -> tuple[dict | None, str | None]:
    url = (req.params.get("url") or "").strip()
    if url:
        identity = deduce_from_url(url) or {}
        provider = (identity.get("provider") or "").strip()
        provider_tenant = (identity.get("providerTenant") or "").strip()
        external_id = (identity.get("externalId") or "").strip()

        if not provider or not external_id:
            return None, "Could not deduce provider/externalId from url"

        identity["provider"] = provider
        identity["providerTenant"] = provider_tenant
        identity["externalId"] = external_id
        identity["identitySource"] = "url"
        return identity, None

    provider = (req.params.get("provider") or "").strip()
    provider_tenant = (req.params.get("providerTenant") or "").strip()
    external_id = (req.params.get("externalId") or "").strip()

    if not provider or external_id == "":
        return None, "Missing required query params: url OR provider, providerTenant, externalId"

    return {
        "provider": provider,
        "providerTenant": provider_tenant,
        "externalId": external_id,
        "identitySource": "explicit",
    }, None


def register(app: func.FunctionApp):
    @app.route(route="jobs/exists", methods=["GET", "HEAD"])
    def job_exists(req: func.HttpRequest) -> func.HttpResponse:
        logging.info("%s /jobs/exists", req.method)

        identity, error = _identity_from_request(req)
        if error:
            return func.HttpResponse(error, status_code=400)

        provider = identity["provider"]
        provider_tenant = identity["providerTenant"]
        external_id = identity["externalId"]

        conn = None
        try:
            conn = get_connection()
            cur = conn.cursor()

            job_id = _find_job_id(cur, provider, provider_tenant, external_id)

            if req.method == "HEAD":
                return func.HttpResponse(status_code=200 if job_id else 404)

            payload = {
                "exists": bool(job_id),
                "id": job_id,
                "provider": provider,
                "providerTenant": provider_tenant,
                "externalId": external_id,
                "foundOn": identity.get("foundOn"),
                "hiringCompanyName": identity.get("hiringCompanyName"),
                "postingCompanyName": identity.get("postingCompanyName"),
                "identitySource": identity.get("identitySource"),
            }

            headers = {}
            if job_id:
                headers["Location"] = f"/jobs/{job_id}"

            return func.HttpResponse(
                json.dumps(payload),
                mimetype="application/json",
                status_code=200,
                headers=headers,
            )

        except Exception as e:
            logging.exception("GET/HEAD /jobs/exists error")
            return func.HttpResponse(f"Server error: {str(e)}", status_code=500)
        finally:
            try:
                if conn:
                    conn.close()
            except Exception:
                pass