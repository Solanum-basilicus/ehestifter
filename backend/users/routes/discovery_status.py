"""Return the current discovery-readiness state for the signed-in user."""

from __future__ import annotations

import json
import logging

import azure.functions as func

from helpers.b2c_headers import get_b2c_headers
from helpers.blob_storage import download_text
from helpers.db import get_connection
from helpers.discovery_readiness import (
    build_discovery_readiness,
    parse_stored_discovery_preferences,
)


def _has_current_cv_metadata(blob_path, version_id) -> bool:
    return (
        isinstance(blob_path, str)
        and bool(blob_path.strip())
        and isinstance(version_id, str)
        and bool(version_id.strip())
    )


def register(app):
    @app.route(route="users/discovery-status", methods=["GET"])
    def get_discovery_status(req: func.HttpRequest) -> func.HttpResponse:
        logging.info("GET /users/discovery-status")
        conn = None
        try:
            b2c_object_id, _, _ = get_b2c_headers(req)
            if not b2c_object_id:
                return func.HttpResponse("Unauthorized", status_code=401)

            conn = get_connection()
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT
                    u.Id,
                    p.CVTextBlobPath,
                    p.CVVersionId,
                    dp.PreferencesJson
                FROM dbo.Users AS u
                LEFT JOIN dbo.UserPreferences AS p
                    ON p.UserId = u.Id
                LEFT JOIN dbo.UserDiscoveryPreferences AS dp
                    ON dp.UserId = u.Id
                WHERE u.B2CObjectId = ?
                """,
                (b2c_object_id,),
            )
            row = cursor.fetchone()
            if row is None:
                return func.HttpResponse("User not found", status_code=404)

            cv_text_blob_path = row[1]
            cv_version_id = row[2]
            cv_plain_text = (
                download_text(cv_text_blob_path)
                if _has_current_cv_metadata(cv_text_blob_path, cv_version_id)
                else None
            )
            discovery_preferences, discovery_preferences_invalid = (
                parse_stored_discovery_preferences(row[3])
            )
            readiness = build_discovery_readiness(
                cv_plain_text=cv_plain_text,
                discovery_preferences=discovery_preferences,
                discovery_preferences_invalid=discovery_preferences_invalid,
            )

            return func.HttpResponse(
                json.dumps({"schemaVersion": 1, **readiness}),
                status_code=200,
                mimetype="application/json",
            )
        except Exception as exc:
            logging.exception("GET /users/discovery-status failed")
            return func.HttpResponse(f"Error: {str(exc)}", status_code=500)
        finally:
            try:
                if conn is not None:
                    conn.close()
            except Exception:
                pass
