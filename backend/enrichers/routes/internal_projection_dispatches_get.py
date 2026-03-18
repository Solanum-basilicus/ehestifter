# /routes/internal_projection_dispatches_get.py
from __future__ import annotations

import json
import logging
import azure.functions as func
from helpers.db import get_connection


def _iso(v):
    if v is None:
        return None
    try:
        return v.isoformat()
    except Exception:
        return str(v)


def register(app: func.FunctionApp):
    @app.route(
        route="internal/enrichment/runs/{runId:guid}/projection-dispatches",
        methods=["GET"],
    )
    def get_projection_dispatches(req: func.HttpRequest) -> func.HttpResponse:
        run_id = req.route_params["runId"]

        try:
            conn = get_connection()
            cur = conn.cursor()

            cur.execute(
                """
                SELECT
                    DispatchId,
                    RunId,
                    EnricherType,
                    ProjectionType,
                    TargetDomain,
                    TargetKey,
                    Status,
                    AttemptCount,
                    LastAttemptAt,
                    NextAttemptAt,
                    LastError,
                    CreatedAt,
                    UpdatedAt
                FROM dbo.EnrichmentProjectionDispatch
                WHERE RunId = ?
                ORDER BY CreatedAt DESC
                """,
                run_id,
            )

            rows = cur.fetchall()
            cols = [c[0] for c in cur.description]

            items = []
            for r in rows:
                d = dict(zip(cols, r))

                items.append(
                    {
                        "dispatchId": str(d.get("DispatchId")),
                        "runId": str(d.get("RunId")),
                        "enricherType": d.get("EnricherType"),
                        "projectionType": d.get("ProjectionType"),
                        "targetDomain": d.get("TargetDomain"),
                        "targetKey": d.get("TargetKey"),
                        "status": d.get("Status"),
                        "attemptCount": d.get("AttemptCount"),
                        "lastAttemptAt": _iso(d.get("LastAttemptAt")),
                        "nextAttemptAt": _iso(d.get("NextAttemptAt")),
                        "lastError": d.get("LastError"),
                        "createdAt": _iso(d.get("CreatedAt")),
                        "updatedAt": _iso(d.get("UpdatedAt")),
                    }
                )

            return func.HttpResponse(
                body=json.dumps({"items": items}),
                status_code=200,
                mimetype="application/json",
            )

        except Exception as ex:
            logging.exception(
                "GET /internal/enrichment/runs/%s/projection-dispatches failed",
                run_id,
            )

            error_body = {
                "error": str(ex),
                "type": type(ex).__name__,
                "trace": traceback.format_exc()[:2000],  # truncate to keep response sane
            }

            return func.HttpResponse(
                body=json.dumps(error_body),
                status_code=500,
                mimetype="application/json",
            )

        finally:
            if conn:
                try:
                    conn.close()
                except Exception:
                    pass
