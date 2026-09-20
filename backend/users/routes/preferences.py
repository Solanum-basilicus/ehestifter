"""CV endpoints.

/users/cv is the public contract. /users/preferences stays as a temporary
compatibility alias during the Core and Users deployment transition.
"""

import hashlib
import json
import logging

import azure.functions as func

from helpers.analytics import emit_users_event
from helpers.b2c_headers import get_b2c_headers
from helpers.blob_storage import download_json, download_text, upload_json, upload_text
from helpers.db import get_connection
from helpers.quill_to_text import canonical_json, normalize_text, quill_delta_to_text


def _update_cv(req: func.HttpRequest) -> func.HttpResponse:
    conn = None
    try:
        b2c_object_id, _, _ = get_b2c_headers(req)
        if not b2c_object_id:
            return func.HttpResponse("Unauthorized", status_code=401)

        try:
            data = req.get_json()
        except ValueError:
            return func.HttpResponse("Invalid JSON", status_code=400)
        if not isinstance(data, dict):
            return func.HttpResponse("Body must be a JSON object", status_code=400)

        cv_quill = data.get("CVQuillDelta")
        if cv_quill is None:
            return func.HttpResponse("Missing CVQuillDelta", status_code=400)

        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT Id FROM Users WHERE B2CObjectId = ?", b2c_object_id)
        user_row = cursor.fetchone()
        if not user_row:
            return func.HttpResponse("User not found", status_code=404)
        user_id = user_row[0]

        canonical = canonical_json(cv_quill)
        cv_version_id = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        rich_blob_path = f"cv/quill/{user_id}/{cv_version_id}.json"
        text_blob_path = f"cv/text/{user_id}/{cv_version_id}.txt"
        plain_norm = normalize_text(quill_delta_to_text(cv_quill))

        upload_json(rich_blob_path, canonical, overwrite=True)
        upload_text(text_blob_path, plain_norm, overwrite=True)

        cursor.execute(
            """
            MERGE dbo.UserPreferences AS target
            USING (
                SELECT
                    ? AS UserId,
                    ? AS CVBlobPath,
                    ? AS CVTextBlobPath,
                    ? AS CVVersionId
            ) AS source
            ON target.UserId = source.UserId
            WHEN MATCHED THEN
                UPDATE SET
                    CVBlobPath = source.CVBlobPath,
                    CVTextBlobPath = source.CVTextBlobPath,
                    CVVersionId = source.CVVersionId,
                    LastUpdated = SYSDATETIME()
            WHEN NOT MATCHED THEN
                INSERT (UserId, CVBlobPath, CVTextBlobPath, CVVersionId, LastUpdated)
                VALUES (source.UserId, source.CVBlobPath, source.CVTextBlobPath, source.CVVersionId, SYSDATETIME());
            """,
            (user_id, rich_blob_path, text_blob_path, cv_version_id),
        )
        conn.commit()

        emit_users_event(
            "CV Updated",
            req=req,
            user_id=str(user_id),
            subject_type="cv",
            subject_id=cv_version_id,
            properties={"cv_version_id": cv_version_id},
        )

        return func.HttpResponse(
            body=json.dumps(
                {
                    "message": "CV updated",
                    "CVBlobPath": rich_blob_path,
                    "CVTextBlobPath": text_blob_path,
                    "CVVersionId": cv_version_id,
                }
            ),
            status_code=200,
            mimetype="application/json",
        )
    except Exception as exc:
        logging.exception("USERS/CV update failed")
        return func.HttpResponse(f"Error: {str(exc)}", status_code=500)
    finally:
        try:
            if conn is not None:
                conn.close()
        except Exception:
            pass


def _get_cv(req: func.HttpRequest) -> func.HttpResponse:
    conn = None
    try:
        b2c_object_id, _, _ = get_b2c_headers(req)
        if not b2c_object_id:
            return func.HttpResponse("Unauthorized", status_code=401)

        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT Id FROM Users WHERE B2CObjectId = ?", b2c_object_id)
        user_row = cursor.fetchone()
        if not user_row:
            return func.HttpResponse("User not found", status_code=404)
        user_id = user_row[0]

        cursor.execute(
            """
            SELECT CVBlobPath, CVTextBlobPath, CVVersionId, LastUpdated
            FROM dbo.UserPreferences
            WHERE UserId = ?
            """,
            (user_id,),
        )
        pref = cursor.fetchone()
        if not pref:
            return func.HttpResponse("CV not found", status_code=404)

        cv_blob_path, cv_text_blob_path, cv_version_id, last_updated = pref
        cv_quill_delta = download_json(cv_blob_path) if cv_blob_path else None
        cv_plain_text = download_text(cv_text_blob_path) if cv_text_blob_path else None

        return func.HttpResponse(
            body=json.dumps(
                {
                    "UserId": str(user_id),
                    "CVBlobPath": cv_blob_path,
                    "CVTextBlobPath": cv_text_blob_path,
                    "CVVersionId": cv_version_id,
                    "LastUpdated": last_updated.isoformat() if last_updated else None,
                    "CVQuillDelta": cv_quill_delta,
                    "CVPlainText": cv_plain_text,
                }
            ),
            status_code=200,
            mimetype="application/json",
        )
    except Exception as exc:
        logging.exception("USERS/CV read failed")
        return func.HttpResponse(f"Error: {str(exc)}", status_code=500)
    finally:
        try:
            if conn is not None:
                conn.close()
        except Exception:
            pass


def register(app):
    @app.route(route="users/cv", methods=["POST"])
    def update_user_cv(req: func.HttpRequest) -> func.HttpResponse:
        logging.info("POST /users/cv")
        return _update_cv(req)

    @app.route(route="users/cv", methods=["GET"])
    def get_user_cv(req: func.HttpRequest) -> func.HttpResponse:
        logging.info("GET /users/cv")
        return _get_cv(req)

    @app.route(route="users/preferences", methods=["POST"])
    def update_user_preferences_compat(req: func.HttpRequest) -> func.HttpResponse:
        logging.info("POST /users/preferences compatibility alias")
        return _update_cv(req)

    @app.route(route="users/preferences", methods=["GET"])
    def get_user_preferences_compat(req: func.HttpRequest) -> func.HttpResponse:
        logging.info("GET /users/preferences compatibility alias")
        return _get_cv(req)
