"""Read and update normalized discovery preferences."""

import json
import logging

import azure.functions as func

from helpers.b2c_headers import get_b2c_headers
from helpers.db import get_connection
from helpers.discovery_preferences import (
    SCHEMA_VERSION,
    default_discovery_preferences,
    normalize_discovery_preferences,
)


def _user_id(cursor, b2c_object_id):
    cursor.execute("SELECT Id FROM dbo.Users WHERE B2CObjectId = ?", b2c_object_id)
    row = cursor.fetchone()
    return row[0] if row else None


def register(app):
    @app.route(route="users/discovery-preferences", methods=["GET"])
    def get_discovery_preferences(req: func.HttpRequest) -> func.HttpResponse:
        logging.info("GET /users/discovery-preferences")
        conn = None
        try:
            b2c_object_id, _, _ = get_b2c_headers(req)
            if not b2c_object_id:
                return func.HttpResponse("Unauthorized", status_code=401)

            conn = get_connection()
            cursor = conn.cursor()
            user_id = _user_id(cursor, b2c_object_id)
            if user_id is None:
                return func.HttpResponse("User not found", status_code=404)

            cursor.execute(
                """
                SELECT SchemaVersion, PreferencesJson, LastUpdated
                FROM dbo.UserDiscoveryPreferences
                WHERE UserId = ?
                """,
                (user_id,),
            )
            row = cursor.fetchone()
            if row is None:
                payload = {
                    **default_discovery_preferences(),
                    "LastUpdated": None,
                    "PreferencesMissing": True,
                }
            else:
                if row[0] != SCHEMA_VERSION:
                    raise ValueError("Stored discovery-preference schema version is not supported")
                stored = normalize_discovery_preferences(
                    json.loads(row[1]),
                    reject_location_conflicts=False,
                )
                payload = {
                    **stored,
                    "LastUpdated": row[2].isoformat() if row[2] else None,
                    "PreferencesMissing": False,
                }
            return func.HttpResponse(
                json.dumps(payload), status_code=200, mimetype="application/json"
            )
        except Exception as exc:
            logging.exception("GET /users/discovery-preferences failed")
            return func.HttpResponse(f"Error: {str(exc)}", status_code=500)
        finally:
            try:
                if conn is not None:
                    conn.close()
            except Exception:
                pass

    @app.route(route="users/discovery-preferences", methods=["PUT"])
    def put_discovery_preferences(req: func.HttpRequest) -> func.HttpResponse:
        logging.info("PUT /users/discovery-preferences")
        conn = None
        try:
            b2c_object_id, _, _ = get_b2c_headers(req)
            if not b2c_object_id:
                return func.HttpResponse("Unauthorized", status_code=401)
            try:
                body = req.get_json()
            except ValueError:
                return func.HttpResponse("Invalid JSON", status_code=400)
            try:
                normalized = normalize_discovery_preferences(body)
            except ValueError as exc:
                return func.HttpResponse(str(exc), status_code=400)

            conn = get_connection()
            cursor = conn.cursor()
            user_id = _user_id(cursor, b2c_object_id)
            if user_id is None:
                return func.HttpResponse("User not found", status_code=404)

            normalized_json = json.dumps(
                normalized, ensure_ascii=False, separators=(",", ":"), sort_keys=True
            )
            cursor.execute(
                """
                MERGE dbo.UserDiscoveryPreferences AS target
                USING (
                    SELECT ? AS UserId, ? AS SchemaVersion, ? AS PreferencesJson
                ) AS source
                ON target.UserId = source.UserId
                WHEN MATCHED THEN
                    UPDATE SET
                        SchemaVersion = source.SchemaVersion,
                        PreferencesJson = source.PreferencesJson,
                        LastUpdated = SYSUTCDATETIME()
                WHEN NOT MATCHED THEN
                    INSERT (UserId, SchemaVersion, PreferencesJson, LastUpdated)
                    VALUES (
                        source.UserId,
                        source.SchemaVersion,
                        source.PreferencesJson,
                        SYSUTCDATETIME()
                    );
                """,
                (user_id, SCHEMA_VERSION, normalized_json),
            )
            conn.commit()
            return func.HttpResponse(
                json.dumps({**normalized, "message": "Discovery preferences updated"}),
                status_code=200,
                mimetype="application/json",
            )
        except Exception as exc:
            logging.exception("PUT /users/discovery-preferences failed")
            return func.HttpResponse(f"Error: {str(exc)}", status_code=500)
        finally:
            try:
                if conn is not None:
                    conn.close()
            except Exception:
                pass
