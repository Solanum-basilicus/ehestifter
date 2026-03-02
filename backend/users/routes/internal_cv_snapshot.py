# routes/cv_snapshot.py
import json
import logging
import azure.functions as func

from helpers.db import get_connection
from helpers.blob_storage import download_text

# If you already have this helper (used in telegram_link.py), reuse it.
# If you don't, you can remove it and just pass user_id through.
from helpers.guid import normalize_guid


def register(app: func.FunctionApp):
    @app.route(
        route="users/internal/{userId}/cv-snapshot",
        methods=["GET"],
        auth_level=func.AuthLevel.FUNCTION,  # <-- function key required (no B2C)
    )
    def get_user_internal_cv_snapshot(req: func.HttpRequest) -> func.HttpResponse:
        logging.info("USERS/internal/CV-snapshot processed a request.")

        conn = None
        try:
            user_id = (req.route_params or {}).get("userId")
            if not user_id:
                return func.HttpResponse("Missing userId", status_code=400)

            # Normalize to the GUID format your DB expects (optional but recommended)
            try:
                user_id_norm = normalize_guid(user_id)
            except Exception:
                return func.HttpResponse("Invalid userId", status_code=400)

            conn = get_connection()
            cursor = conn.cursor()

            cursor.execute(
                """
                SELECT
                    CVTextBlobPath,
                    CVVersionId,
                    LastUpdated
                FROM dbo.UserPreferences
                WHERE UserId = ?
                """,
                (user_id_norm,),
            )
            row = cursor.fetchone()
            if not row:
                return func.HttpResponse("CV not found", status_code=404)

            cv_text_blob_path, cv_version_id, last_updated = row

            if not cv_text_blob_path:
                return func.HttpResponse("CV text blob path missing", status_code=404)

            cv_plain_text = download_text(cv_text_blob_path)
            if cv_plain_text is None:
                return func.HttpResponse("CV text blob missing", status_code=404)

            payload = {
                "UserId": user_id_norm,
                "CVVersionId": cv_version_id,
                "LastUpdated": last_updated.isoformat() if last_updated else None,
                "CVTextBlobPath": cv_text_blob_path,  # keep or drop; useful for debugging
                "CVPlainText": cv_plain_text,
            }

            return func.HttpResponse(
                body=json.dumps(payload),
                status_code=200,
                mimetype="application/json",
            )

        except Exception as e:
            logging.exception("USERS/CV-PLAINTEXT: Error c30001")
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)

        finally:
            try:
                if conn is not None:
                    conn.close()
            except Exception:
                pass