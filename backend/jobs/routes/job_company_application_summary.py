"""Read a user's first recorded application for each active job at a company."""

import json
import logging

import azure.functions as func

from helpers.auth import UnauthorizedError, get_current_user_id
from helpers.db import get_connection
from helpers.ids import is_guid, normalize_guid


# History writes use SYSDATETIME(). Use the same clock for time windows.
# Return a separate UTC timestamp. Read all events before the date filter:
# a recent status change must not make an older application look new.
COMPANY_APPLICATION_SQL = """
WITH NamedJobs AS (
    SELECT j.Id,
           COALESCE(valid.HiringName, valid.PostingName) AS CompanyName,
           CASE WHEN valid.HiringName IS NOT NULL THEN N'hiring'
                WHEN valid.PostingName IS NOT NULL THEN N'posting'
                ELSE NULL END AS MatchBasis
    FROM dbo.JobOfferings AS j
    CROSS APPLY (VALUES (
        NULLIF(LTRIM(RTRIM(j.HiringCompanyName)), N''),
        NULLIF(LTRIM(RTRIM(j.PostingCompanyName)), N'')
    )) AS trimmed(HiringName, PostingName)
    CROSS APPLY (VALUES (
        CASE WHEN UPPER(trimmed.HiringName) = N'UNKNOWN'
             THEN NULL ELSE trimmed.HiringName END,
        CASE WHEN UPPER(trimmed.PostingName) = N'UNKNOWN'
             THEN NULL ELSE trimmed.PostingName END
    )) AS valid(HiringName, PostingName)
    WHERE j.IsDeleted = 0
),
Target AS (
    SELECT CompanyName, MatchBasis
    FROM NamedJobs
    WHERE Id = ?
),
FirstApplications AS (
    SELECT h.JobOfferingId, MIN(h.Timestamp) AS AppliedAt
    FROM dbo.JobOfferingHistory AS h
    INNER JOIN NamedJobs AS j ON j.Id = h.JobOfferingId
    INNER JOIN Target AS t ON t.CompanyName IS NOT NULL
         AND j.CompanyName COLLATE Latin1_General_100_CI_AS
             = t.CompanyName COLLATE Latin1_General_100_CI_AS
    CROSS APPLY (VALUES (
        CASE WHEN h.Action LIKE N'status:%' THEN SUBSTRING(h.Action, 8, 100)
             WHEN h.Action IN (N'status_changed', N'status-changed')
                  AND ISJSON(h.Details) = 1
             THEN COALESCE(
                 JSON_VALUE(h.Details, '$.to'),
                 JSON_VALUE(h.Details, '$.status'),
                 JSON_VALUE(h.Details, '$.data.to'),
                 JSON_VALUE(h.Details, '$.data.status')
             )
             ELSE NULL END
    )) AS status_event(Status)
    WHERE h.ActorType = N'user' AND h.ActorId = ?
      AND (h.Action LIKE N'status:%'
           OR h.Action IN (N'status_changed', N'status-changed'))
      AND NULLIF(LTRIM(RTRIM(status_event.Status)), N'') IS NOT NULL
      AND UPPER(LTRIM(RTRIM(status_event.Status))) NOT IN (N'UNSET', N'IGNORED', N'NEW')
    GROUP BY h.JobOfferingId
)
SELECT t.CompanyName, t.MatchBasis,
       COUNT(CASE WHEN a.AppliedAt >= DATEADD(day, -90, clock.EventNow)
                       AND a.AppliedAt <= clock.EventNow THEN 1 END) AS Last90Days,
       COUNT(CASE WHEN a.AppliedAt >= DATEADD(day, -365, clock.EventNow)
                       AND a.AppliedAt <= clock.EventNow THEN 1 END) AS Last365Days,
       clock.AsOfUtc
FROM Target AS t
CROSS JOIN (SELECT SYSDATETIME() AS EventNow,
                   SYSUTCDATETIME() AS AsOfUtc) AS clock
LEFT JOIN FirstApplications AS a ON 1 = 1
GROUP BY t.CompanyName, t.MatchBasis, clock.EventNow, clock.AsOfUtc
"""


def read_company_applications(cur, job_id: str, user_id: str):
    """Return None for a missing or deleted job, or a summary for an active job."""
    cur.execute(COMPANY_APPLICATION_SQL, (job_id, user_id))
    row = cur.fetchone()
    if row is None:
        return None

    company, match_basis, count_90, count_365, as_of_utc = row
    available = company is not None
    return {
        "available": available,
        "companyName": company if available else None,
        "matchBasis": match_basis if available else None,
        "last90Days": int(count_90) if available else None,
        "last365Days": int(count_365) if available else None,
        "asOfUtc": as_of_utc.isoformat(timespec="milliseconds") + "Z",
    }


def register(app: func.FunctionApp):
    @app.route(route="jobs/{jobId}/company-application-summary", methods=["GET"])
    def get_company_application_summary(req: func.HttpRequest) -> func.HttpResponse:
        conn = None
        try:
            user_id = get_current_user_id(req)
            raw_id = req.route_params.get("jobId")
            if not is_guid(raw_id):
                return func.HttpResponse("Invalid jobId", status_code=400)
            job_id = normalize_guid(raw_id)

            conn = get_connection()
            summary = read_company_applications(conn.cursor(), job_id, user_id)
            if summary is None:
                return func.HttpResponse("Job not found", status_code=404)
            return func.HttpResponse(json.dumps(summary), mimetype="application/json", status_code=200)
        except UnauthorizedError as exc:
            return func.HttpResponse(str(exc), status_code=401)
        except Exception:
            logging.exception("GET company application summary failed")
            return func.HttpResponse("Server error", status_code=500)
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    logging.exception("Could not close company application summary SQL connection")
