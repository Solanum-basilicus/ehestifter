# enrichers/routes/enrichment_runs_get.py
import json
import logging
import os
import azure.functions as func

from helpers.runs_create import list_runs_by_status

def _require_internal_key(req: func.HttpRequest) -> bool:
    # Optional but strongly recommended
    expected = os.getenv("ENRICHERS_INTERNAL_API_KEY")
    if not expected:
        return True  # allow in dev if not configured
    got = req.headers.get("x-api-key") or req.headers.get("x-functions-key")
    return got == expected

def _iso(v):
    if v is None:
        return None
    try:
        return v.isoformat()
    except Exception:
        return str(v)

def register(app: func.FunctionApp):
    @app.route(route="enrichment/runs", methods=["GET"])
    def list_runs(req: func.HttpRequest) -> func.HttpResponse:
        if not _require_internal_key(req):
            return func.HttpResponse("Unauthorized", status_code=401)

        status = req.params.get("status") or req.params.get("Status") or "Pending"
        limit_s = req.params.get("limit") or req.params.get("Limit") or "100"
        offset_s = req.params.get("offset") or req.params.get("Offset") or "0"

        try:
            limit = int(limit_s)
            offset = int(offset_s)
        except Exception:
            return func.HttpResponse("Invalid limit/offset", status_code=400)

        logging.info("GET /enrichment/runs status=%s limit=%s offset=%s", status, limit, offset)

        try:
            total, rows = list_runs_by_status(status=status, limit=limit, offset=offset)
        except ValueError as e:
            return func.HttpResponse(str(e), status_code=400)

        # Minimal, gateway-friendly shape (no need for RunsService normalization here)
        items = []
        for r in rows:
            items.append({
                "runId": str(r.get("RunId")),
                "enricherType": r.get("EnricherType"),
                "subjectKey": r.get("SubjectKey"),
                "jobOfferingId": str(r.get("JobOfferingId")),
                "userId": str(r.get("UserId")),
                "status": r.get("Status"),
                "requestedAt": _iso(r.get("RequestedAt")),
                "queuedAt": _iso(r.get("QueuedAt")),
                "cvVersionId": r.get("CVVersionId"),
                "inputSnapshotBlobPath": r.get("InputSnapshotBlobPath"),
                "updatedAt": _iso(r.get("UpdatedAt")),
            })

        has_more = (offset + len(items)) < total

        return func.HttpResponse(
            json.dumps({
                "status": status,
                "limit": limit,
                "offset": offset,
                "total": total,
                "hasMore": has_more,
                "items": items,
            }),
            mimetype="application/json",
            status_code=200,
        )