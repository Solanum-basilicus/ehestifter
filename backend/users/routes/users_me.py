import json
import logging
import azure.functions as func
from helpers.db import get_connection
from helpers.guid import normalize_guid
from helpers.json import DatetimeEncoder
from helpers.b2c_headers import get_b2c_headers

def register(app):
    @app.route(route="users/me", methods=["GET"])
    def get_or_create_user(req: func.HttpRequest) -> func.HttpResponse:
        logging.info('USERS/ME processed a request.')

        try:
            b2c_object_id, email, username = get_b2c_headers(req)
            if not b2c_object_id:
                return func.HttpResponse("Unauthorized", status_code=401)

            email = req.headers.get("x-user-email", None)
            username = req.headers.get("x-user-name", None)

            conn = get_connection()
            cursor = conn.cursor()

            cursor.execute("""
                SELECT Id, Email, Username, Role 
                FROM Users 
                WHERE B2CObjectId = ?
            """, b2c_object_id)
            row = cursor.fetchone()

            if row:
                user_id, email, username, role = row
            else:
                cursor.execute("""
                    INSERT INTO Users (B2CObjectId, Email, Username)
                    OUTPUT inserted.Id, inserted.Email, inserted.Username, inserted.Role
                    VALUES (?, ?, ?)
                """, b2c_object_id, email, username)
                user_id, email, username, role = cursor.fetchone()
                conn.commit()

            user_data = {
                "userId": normalize_guid(user_id),
                "email": email,
                "username": username,
                "role": role
            }

            return func.HttpResponse(json.dumps(user_data), status_code=200, mimetype="application/json")

        except ValueError:
            return func.HttpResponse("Invalid JSON", status_code=400)        
        except Exception as e:
            logging.exception("USER/ME: Error m10001")
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)