import json
import logging

import azure.functions as func

from helpers.db import get_connection
from helpers.ids import is_guid, normalize_guid
from helpers.locations_v2 import load_locations_v2_catalog, project_legacy_locations
from helpers.locations_v2_store import replace_legacy_projection_v2


DEFAULT_LIMIT = 100
MAX_LIMIT = 500


def _parse_body(req: func.HttpRequest) -> dict:
    try:
        body = req.get_json()
    except ValueError:
        raise ValueError("Invalid JSON")
    if body is None:
        return {}
    if not isinstance(body, dict):
        raise ValueError("Body must be a JSON object")
    return body


def _parse_limit(value) -> int:
    if value is None:
        return DEFAULT_LIMIT
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("limit must be an integer")
    if value < 1 or value > MAX_LIMIT:
        raise ValueError(f"limit must be between 1 and {MAX_LIMIT}")
    return value



def register(app: func.FunctionApp):

    @app.route(route="internal/jobs/locations-v2:backfill", methods=["POST"])
    def post_locations_v2_backfill(req: func.HttpRequest) -> func.HttpResponse:
        logging.info("POST /internal/jobs/locations-v2:backfill")
        conn = None
        try:
            try:
                body = _parse_body(req)
                limit = _parse_limit(body.get("limit"))
                dry_run = body.get("dryRun", False)
                if not isinstance(dry_run, bool):
                    raise ValueError("dryRun must be a boolean")
                after_job_id = body.get("afterJobId")
                if after_job_id is not None:
                    if not isinstance(after_job_id, str) or not is_guid(after_job_id):
                        raise ValueError("afterJobId must be a GUID or null")
                    after_job_id = normalize_guid(after_job_id)
            except ValueError as exc:
                return func.HttpResponse(str(exc), status_code=400)

            try:
                catalog = load_locations_v2_catalog()
            except (FileNotFoundError, ValueError) as exc:
                logging.error("Locations v2 catalog is not ready: %s", exc)
                return func.HttpResponse(str(exc), status_code=503)

            conn = get_connection()
            cur = conn.cursor()

            where_cursor = ""
            params = []
            if after_job_id:
                where_cursor = "AND j.Id > CAST(? AS uniqueidentifier)"
                params.append(after_job_id)

            query_limit = limit + 1
            batch_sql = f"""
                SELECT TOP {query_limit} j.Id
                FROM dbo.JobOfferings j
                WHERE j.IsDeleted = 0
                  AND EXISTS (
                      SELECT 1
                      FROM dbo.JobOfferingLocations l
                      WHERE l.JobOfferingId = j.Id
                  )
                  {where_cursor}
                ORDER BY j.Id
            """
            if params:
                cur.execute(batch_sql, params)
            else:
                cur.execute(batch_sql)
            job_ids = [normalize_guid(str(row[0])) for row in cur.fetchall()]
            has_more = len(job_ids) > limit
            batch_ids = job_ids[:limit]

            stats = {
                "processedJobs": 0,
                "sourceLocations": 0,
                "directLocations": 0,
                "facts": 0,
                "utcOffsets": 0,
                "fallbackSourceLocations": 0,
                "unresolvedSourceLocations": 0,
                "skippedNativeV2Jobs": 0,
            }

            for job_id in batch_ids:
                cur.execute(
                    """
                    SELECT Id, CountryName, CountryCode, CityName, Region
                    FROM dbo.JobOfferingLocations
                    WHERE JobOfferingId = ?
                    ORDER BY Id
                    """,
                    (job_id,),
                )
                source_rows = [
                    {
                        "id": int(row[0]),
                        "countryName": row[1],
                        "countryCode": row[2],
                        "cityName": row[3],
                        "region": row[4],
                    }
                    for row in cur.fetchall()
                ]
                projection = project_legacy_locations(catalog, source_rows)

                cur.execute(
                    """
                    SELECT COUNT(*)
                    FROM dbo.JobOfferingLocationsV2
                    WHERE JobOfferingId = ?
                      AND SourceLocationV1Id IS NULL
                    """,
                    (job_id,),
                )
                has_native_v2 = int(cur.fetchone()[0] or 0) > 0
                if has_native_v2:
                    stats["skippedNativeV2Jobs"] += 1
                    continue

                if not dry_run:
                    replace_legacy_projection_v2(cur, catalog, job_id, projection)

                stats["processedJobs"] += 1
                stats["sourceLocations"] += projection["sourceCount"]
                stats["directLocations"] += len(projection["direct"])
                stats["facts"] += projection["branchFactCount"]
                stats["utcOffsets"] += projection["branchUtcOffsetCount"]
                stats["fallbackSourceLocations"] += projection["fallbackCount"]
                stats["unresolvedSourceLocations"] += projection["unresolvedCount"]

            if dry_run:
                conn.rollback()
            else:
                conn.commit()

            next_after_job_id = batch_ids[-1] if batch_ids else after_job_id
            response = {
                "catalogVersion": catalog.catalog_version,
                "referenceYear": catalog.reference_year,
                "dryRun": dry_run,
                "hasMore": has_more,
                "nextAfterJobId": next_after_job_id,
                **stats,
            }
            return func.HttpResponse(
                json.dumps(response),
                mimetype="application/json",
                status_code=200,
            )

        except Exception as exc:
            logging.exception("POST /internal/jobs/locations-v2:backfill error")
            try:
                if conn:
                    conn.rollback()
            except Exception:
                pass
            return func.HttpResponse(f"Error: {str(exc)}", status_code=500)
