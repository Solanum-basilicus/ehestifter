# routes/internal_job_snapshot_get.py
import json
import logging
import azure.functions as func

from helpers.db import get_connection
from helpers.ids import normalize_guid

def _company_name(hiring: str, posting: str | None) -> str:
    """
    Business rule:
    - If PostingCompanyName is present -> "HiringCompanyName (through agency PostingCompanyName)"
    - Else -> "HiringCompanyName"
    """
    if posting and posting.strip():
        return f"{hiring} (through agency {posting})"
    return hiring


def register(app: func.FunctionApp):

    @app.route(route="internal/jobs/{jobId:guid}/snapshot", methods=["GET"])
    def get_job_snapshot(req: func.HttpRequest) -> func.HttpResponse:
        job_id = req.route_params.get("jobId")
        logging.info("GET /internal/jobs/%s/snapshot", job_id)

        try:
            conn = get_connection()
            cur = conn.cursor()

            cur.execute(
                """
                SELECT
                    Id,
                    Title,
                    HiringCompanyName,
                    PostingCompanyName,
                    Description
                FROM dbo.JobOfferings
                WHERE Id = ? AND IsDeleted = 0
                """,
                job_id,
            )
            row = cur.fetchone()
            if not row:
                return func.HttpResponse("Not found", status_code=404)

            # row order matches SELECT
            _id, title, hiring_company, posting_company, description = row

            payload = {
                "jobId": normalize_guid(_id),
                "jobName": title,  # keeping it explicit + stable for downstream
                "companyName": _company_name(hiring_company, posting_company),
                "jobDescription": description,
            }

            return func.HttpResponse(
                json.dumps(payload),
                mimetype="application/json",
                status_code=200,
            )

        except Exception as e:
            logging.exception("GET /internal/jobs/{jobId}/snapshot error")
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)