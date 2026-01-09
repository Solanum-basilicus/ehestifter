import json
import logging
import azure.functions as func
from helpers.db import get_connection
from helpers.b2c_headers import get_b2c_headers

def register(app):
    @app.route(route="users/preferences", methods=["POST"])
    def update_user_preferences(req: func.HttpRequest) -> func.HttpResponse:
        logging.info('USERS/PREFERENCES processed a request.')

        try:
            b2c_object_id, _, _ = get_b2c_headers(req)
            if not b2c_object_id:
                return func.HttpResponse("Unauthorized", status_code=401)

            data = req.get_json()
            cv_path = data.get("CVBlobPath")
            if not cv_path:
                return func.HttpResponse("Missing CVBlobPath", status_code=400)

            conn = get_connection()
            cursor = conn.cursor()

            # Get User ID
            cursor.execute("SELECT Id FROM Users WHERE B2CObjectId = ?", b2c_object_id)
            user_row = cursor.fetchone()
            if not user_row:
                return func.HttpResponse("User not found", status_code=404)

            user_id = user_row[0]

            # Upsert preference
            cursor.execute("""
                MERGE UserPreferences AS target
                USING (SELECT ? AS UserId, ? AS CVBlobPath) AS source
                ON target.UserId = source.UserId
                WHEN MATCHED THEN
                    UPDATE SET CVBlobPath = source.CVBlobPath, LastUpdated = SYSDATETIME()
                WHEN NOT MATCHED THEN
                    INSERT (UserId, CVBlobPath, LastUpdated)
                    VALUES (source.UserId, source.CVBlobPath, SYSDATETIME());
            """, (user_id, cv_path))

            conn.commit()
            return func.HttpResponse("Preferences updated", status_code=200)

        except ValueError:
            return func.HttpResponse("Invalid JSON", status_code=400)
        except Exception as e:
            logging.exception("USER/PREFERENCES: Error m20001")
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)