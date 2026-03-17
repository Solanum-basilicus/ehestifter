# routes/internal_job_compatibility_projections_bulk_upsert.py
import json
import logging
from datetime import datetime, timezone

import azure.functions as func

from helpers.db import get_connection
from helpers.ids import normalize_guid, is_guid


MAX_ITEMS = 500


def _parse_iso_dt(value: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("calculatedAt must be a non-empty ISO datetime string")

    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"

    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        raise ValueError("calculatedAt must include timezone info")

    return dt.astimezone(timezone.utc)


def _validate_score(value):
    if not isinstance(value, (int, float)):
        raise ValueError("score must be a number")

    score = round(float(value), 1)
    if score < 0.0 or score > 10.0:
        raise ValueError("score must be between 0.0 and 10.0")

    return score


def register(app: func.FunctionApp):

    @app.route(
        route="internal/jobs/compatibility-projections:bulk-upsert",
        methods=["POST"],
    )
    def post_compatibility_projections_bulk_upsert(req: func.HttpRequest) -> func.HttpResponse:
        logging.info("POST /internal/jobs/compatibility-projections:bulk-upsert")

        try:
            try:
                body = req.get_json()
            except ValueError:
                return func.HttpResponse("Invalid JSON", status_code=400)

            if not isinstance(body, dict) or "items" not in body:
                return func.HttpResponse("Body must include 'items' array", status_code=400)

            items = body["items"]
            if not isinstance(items, list):
                return func.HttpResponse("'items' must be an array", status_code=400)

            if len(items) > MAX_ITEMS:
                return func.HttpResponse(f"Too many items (max {MAX_ITEMS})", status_code=400)

            if not items:
                return func.HttpResponse(
                    json.dumps({"accepted": 0, "upserted": 0, "ignored": 0, "results": []}),
                    mimetype="application/json",
                    status_code=200,
                )

            parsed_items = []
            errors = []

            for idx, item in enumerate(items):
                if not isinstance(item, dict):
                    errors.append({"index": idx, "error": "Each item must be an object"})
                    continue

                job_id = item.get("jobId")
                user_id = item.get("userId")
                score_raw = item.get("score")
                explanation = item.get("explanation")
                calculated_at_raw = item.get("calculatedAt")

                if not isinstance(job_id, str) or not is_guid(job_id):
                    errors.append({"index": idx, "error": "Invalid jobId GUID"})
                    continue

                if not isinstance(user_id, str) or not is_guid(user_id):
                    errors.append({"index": idx, "error": "Invalid userId GUID"})
                    continue

                try:
                    score = _validate_score(score_raw)
                except ValueError as e:
                    errors.append({"index": idx, "error": str(e)})
                    continue

                if explanation is not None and not isinstance(explanation, str):
                    errors.append({"index": idx, "error": "explanation must be a string or null"})
                    continue

                try:
                    calculated_at = _parse_iso_dt(calculated_at_raw)
                except ValueError as e:
                    errors.append({"index": idx, "error": str(e)})
                    continue

                parsed_items.append(
                    {
                        "index": idx,
                        "jobId": normalize_guid(job_id),
                        "userId": normalize_guid(user_id),
                        "score": score,
                        "explanation": explanation,
                        "calculatedAt": calculated_at,
                    }
                )

            if errors:
                return func.HttpResponse(
                    json.dumps(
                        {
                            "message": "Validation failed",
                            "errors": errors,
                        }
                    ),
                    mimetype="application/json",
                    status_code=400,
                )

            # De-duplicate within request by (jobId, userId):
            # keep the newest calculatedAt; if tied, keep the later item in the payload.
            dedup = {}
            for item in parsed_items:
                key = (item["jobId"], item["userId"])
                prev = dedup.get(key)
                if prev is None:
                    dedup[key] = item
                    continue

                if item["calculatedAt"] > prev["calculatedAt"]:
                    dedup[key] = item
                elif item["calculatedAt"] == prev["calculatedAt"] and item["index"] > prev["index"]:
                    dedup[key] = item

            effective_items = list(dedup.values())

            conn = get_connection()
            cur = conn.cursor()

            results = []
            upserted = 0
            ignored = 0

            for item in effective_items:
                job_id = item["jobId"]
                user_id = item["userId"]
                score = item["score"]
                explanation = item["explanation"]
                calculated_at = item["calculatedAt"]

                # Read current row first, so we can ignore stale writes cleanly.
                cur.execute(
                    """
                    SELECT Id, CalculatedAt
                    FROM dbo.CompatibilityScores
                    WHERE JobOfferingId = ? AND UserId = ?
                    """,
                    (job_id, user_id),
                )
                existing = cur.fetchone()

                if existing:
                    existing_id, existing_calculated_at = existing

                    # Treat equal timestamp as idempotent overwrite.
                    if existing_calculated_at is not None and existing_calculated_at > calculated_at:
                        ignored += 1
                        results.append(
                            {
                                "jobId": job_id,
                                "userId": user_id,
                                "status": "IgnoredStale",
                            }
                        )
                        continue

                    cur.execute(
                        """
                        UPDATE dbo.CompatibilityScores
                        SET
                            Score = ?,
                            Explanation = ?,
                            CalculatedAt = ?
                        WHERE Id = ?
                        """,
                        (score, explanation, calculated_at, existing_id),
                    )

                    upserted += 1
                    results.append(
                        {
                            "jobId": job_id,
                            "userId": user_id,
                            "status": "Updated",
                        }
                    )
                else:
                    cur.execute(
                        """
                        INSERT INTO dbo.CompatibilityScores
                            (JobOfferingId, UserId, Score, Explanation, CalculatedAt)
                        VALUES (?, ?, ?, ?, ?)
                        """,
                        (job_id, user_id, score, explanation, calculated_at),
                    )

                    upserted += 1
                    results.append(
                        {
                            "jobId": job_id,
                            "userId": user_id,
                            "status": "Inserted",
                        }
                    )

            conn.commit()

            return func.HttpResponse(
                json.dumps(
                    {
                        "accepted": len(effective_items),
                        "upserted": upserted,
                        "ignored": ignored,
                        "results": results,
                    }
                ),
                mimetype="application/json",
                status_code=200,
            )

        except Exception as e:
            logging.exception("POST /internal/jobs/compatibility-projections:bulk-upsert error")
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)