import json
import logging
import hashlib
import azure.functions as func

from helpers.db import get_connection
from helpers.b2c_headers import get_b2c_headers
from helpers.blob_storage import upload_json, upload_text, download_json, download_text
from helpers.quill_to_text import canonical_json, quill_delta_to_text, normalize_text


def register(app):
    @app.route(route="users/preferences", methods=["POST"])
    def update_user_preferences(req: func.HttpRequest) -> func.HttpResponse:
        logging.info("USERS/PREFERENCES processed a request.")

        conn = None
        try:
            b2c_object_id, _, _ = get_b2c_headers(req)
            if not b2c_object_id:
                return func.HttpResponse("Unauthorized", status_code=401)

            try:
                data = req.get_json()
            except ValueError:
                return func.HttpResponse("Invalid JSON", status_code=400)

            cv_quill = data.get("CVQuillDelta")
            if cv_quill is None:
                return func.HttpResponse("Missing CVQuillDelta", status_code=400)

            # Resolve user id
            conn = get_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT Id FROM Users WHERE B2CObjectId = ?", b2c_object_id)
            user_row = cursor.fetchone()
            if not user_row:
                return func.HttpResponse("User not found", status_code=404)

            user_id = user_row[0]

            # Canonicalize + hash -> version id
            canonical = canonical_json(cv_quill)
            cv_version_id = hashlib.sha256(canonical.encode("utf-8")).hexdigest()

            # Deterministic blob paths
            rich_blob_path = f"cv/quill/{user_id}/{cv_version_id}.json"
            text_blob_path = f"cv/text/{user_id}/{cv_version_id}.txt"

            # Convert + normalize text
            plain = quill_delta_to_text(cv_quill)
            plain_norm = normalize_text(plain)

            # Upload blobs (idempotent)
            upload_json(rich_blob_path, canonical, overwrite=True)
            upload_text(text_blob_path, plain_norm, overwrite=True)

            # Upsert preferences (single statement)
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

            return func.HttpResponse(
                body=json.dumps(
                    {
                        "message": "Preferences updated",
                        "CVBlobPath": rich_blob_path,
                        "CVTextBlobPath": text_blob_path,
                        "CVVersionId": cv_version_id,
                    }
                ),
                status_code=200,
                mimetype="application/json",
            )

        except Exception as e:
            logging.exception("USERS/PREFERENCES: Error m20001")
            # Keep message generic if you prefer; leaving str(e) helps while bootstrapping.
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)

        finally:
            try:
                if conn is not None:
                    conn.close()
            except Exception:
                pass

    @app.route(route="users/preferences", methods=["GET"])
    def get_user_preferences(req: func.HttpRequest) -> func.HttpResponse:
        logging.info("USERS/PREFERENCES GET processed a request.")

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
                SELECT
                    CVBlobPath,
                    CVTextBlobPath,
                    CVVersionId,
                    LastUpdated
                FROM dbo.UserPreferences
                WHERE UserId = ?
                """,
                (user_id,),
            )
            pref = cursor.fetchone()
            if not pref:
                return func.HttpResponse("Preferences not found", status_code=404)

            cv_blob_path, cv_text_blob_path, cv_version_id, last_updated = pref

            # For UI/tests: return the Quill JSON and the normalized plaintext.
            # These reads are optional; if blobs missing, return nulls rather than failing hard.
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

        except Exception as e:
            logging.exception("USERS/PREFERENCES GET: Error m20002")
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)

        finally:
            try:
                if conn is not None:
                    conn.close()
            except Exception:
                pass