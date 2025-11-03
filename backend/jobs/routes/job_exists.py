# routes/job_exists.py
import json
import logging
import azure.functions as func
from helpers.db import get_connection
from helpers.ids import normalize_guid

def _find_job_id(cur, provider: str, providerTenant: str, externalId: str):
    cur.execute("""
        SELECT Id
        FROM dbo.JobOfferings
        WHERE IsDeleted = 0
          AND Provider = ?
          AND ProviderTenant = ?
          AND ExternalId = ?
    """, (provider, providerTenant, externalId))
    row = cur.fetchone()
    return normalize_guid(str(row[0])) if row else None

def register(app: func.FunctionApp):

    @app.route(route="jobs/exists", methods=["GET", "HEAD"])
    def job_exists(req: func.HttpRequest) -> func.HttpResponse:
        logging.info("%s /jobs/exists", req.method)

        provider = (req.params.get("provider") or "").strip()
        providerTenant = (req.params.get("providerTenant") or "").strip()
        externalId = (req.params.get("externalId") or "").strip()

        # We require all 3 parts of the uniqueness constraint
        if not provider or externalId is None or providerTenant is None:
            return func.HttpResponse(
                "Missing required query params: provider, providerTenant, externalId",
                status_code=400
            )

        conn = None
        try:
            conn = get_connection()
            cur = conn.cursor()
            job_id = _find_job_id(cur, provider, providerTenant, externalId)

            if req.method == "HEAD":
                # Existence-only contract
                return func.HttpResponse(status_code=200 if job_id else 404)

            # GET: return explicit JSON + helpful Location header if found
            payload = {"exists": bool(job_id), "id": job_id}
            headers = {}
            if job_id:
                headers["Location"] = f"/jobs/{job_id}"

            return func.HttpResponse(
                json.dumps(payload),
                mimetype="application/json",
                status_code=200,
                headers=headers
            )

        except Exception as e:
            logging.exception("GET/HEAD /jobs/exists error")
            return func.HttpResponse(f"Server error: {str(e)}", status_code=500)
        finally:
            try:
                if conn: conn.close()
            except Exception:
                pass
