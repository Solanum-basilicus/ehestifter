import azure.functions as func
from datetime import datetime
import json
import logging
import os
import pyodbc
import secrets
import string

SQL_CONN_STR = os.getenv("SQL_CONNECTION_STRING")

def get_connection():
    try:
        return pyodbc.connect(SQL_CONN_STR, timeout=5)  # Optional: explicitly set timeout
    except pyodbc.InterfaceError as e:
        logging.error("SQL InterfaceError during connect: %s", e)
        raise Exception("Could not connect to the database: network issue or driver failure.")
    except pyodbc.OperationalError as e:
        logging.error("SQL OperationalError during connect: %s", e)
        raise Exception("Could not connect to the database: invalid credentials or timeout.")
    except Exception as e:
        logging.exception("Unhandled database connection error")
        raise Exception("Unexpected error while connecting to the database.")

BOT_FUNCTION_KEY = os.getenv("USERS_BOT_FUNCTION_KEY")

def require_bot_key(req: func.HttpRequest) -> bool:
    # Bot calls must include the x-functions-key header and match our env
    provided = req.headers.get("x-functions-key")
    return (BOT_FUNCTION_KEY is not None) and (provided == BOT_FUNCTION_KEY)

class DatetimeEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, datetime):
            return obj.isoformat()
        return super().default(obj)


app = func.FunctionApp()

@app.route(route="users/me", methods=["GET"])
def get_or_create_user(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('USERS/ME processed a request.')

    try:
        b2c_object_id = req.headers.get("x-user-sub")
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
            "userId": str(user_id),
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

@app.route(route="users/preferences", methods=["POST"])
def update_user_preferences(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('USERS/PREFERENCES processed a request.')

    try:
        b2c_object_id = req.headers.get("x-user-sub")
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


@app.route(route="users/filters", methods=["POST"])
def add_user_filter(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('USERS/FILTERS (POST) processed a request.')

    try:
        b2c_object_id = req.headers.get("x-user-sub")
        if not b2c_object_id:
            return func.HttpResponse("Unauthorized", status_code=401)

        data = req.get_json()
        filter_text = data.get("FilterText")
        normalized_json = data.get("NormalizedJson")

        if not filter_text:
            return func.HttpResponse("Missing FilterText", status_code=400)

        conn = get_connection()
        cursor = conn.cursor()

        # Get User ID
        cursor.execute("SELECT Id FROM Users WHERE B2CObjectId = ?", b2c_object_id)
        user_row = cursor.fetchone()
        if not user_row:
            return func.HttpResponse("User not found", status_code=404)

        user_id = user_row[0]

        cursor.execute("""
            INSERT INTO UserPreferenceFilters (UserId, FilterText, NormalizedJson, CreatedAt)
            OUTPUT inserted.Id
            VALUES (?, ?, ?, SYSDATETIME());
        """, (user_id, filter_text, normalized_json))

        inserted_id = cursor.fetchone()[0]
        conn.commit()

        return func.HttpResponse(json.dumps({"filterId": str(inserted_id)}), status_code=201, mimetype="application/json")

    except ValueError:
        return func.HttpResponse("Invalid JSON", status_code=400)
    except Exception as e:
        logging.exception("USER/FILTERS POST: Error m30001")
        return func.HttpResponse(f"Error: {str(e)}", status_code=500)


@app.route(route="users/filters", methods=["GET"])
def list_user_filters(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('USERS/FILTERS (GET) processed a request.')

    try:
        b2c_object_id = req.headers.get("x-user-sub")
        if not b2c_object_id:
            return func.HttpResponse("Unauthorized", status_code=401)

        conn = get_connection()
        cursor = conn.cursor()

        # Get User ID
        cursor.execute("SELECT Id FROM Users WHERE B2CObjectId = ?", b2c_object_id)
        user_row = cursor.fetchone()
        if not user_row:
            return func.HttpResponse("User not found", status_code=404)

        user_id = user_row[0]

        cursor.execute("""
            SELECT Id, FilterText, NormalizedJson, CreatedAt, LastUsedAt
            FROM UserPreferenceFilters
            WHERE UserId = ?
            ORDER BY CreatedAt DESC
        """, user_id)

        rows = cursor.fetchall()
        filters = []
        for row in rows:
            filters.append({
                "Id": str(row[0]),
                "FilterText": row[1],
                "NormalizedJson": row[2],
                "CreatedAt": row[3],
                "LastUsedAt": row[4],
            })

        return func.HttpResponse(json.dumps(filters, cls=DatetimeEncoder), status_code=200, mimetype="application/json")

    except Exception as e:
        logging.exception("USER/FILTERS GET: Error m30002")
        return func.HttpResponse(f"Error: {str(e)}", status_code=500)


@app.route(route="users/filters/{filter_id}", methods=["DELETE"])
def delete_user_filter(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('USERS/FILTERS (DELETE) processed a request.')

    try:
        b2c_object_id = req.headers.get("x-user-sub")
        if not b2c_object_id:
            return func.HttpResponse("Unauthorized", status_code=401)

        filter_id = req.route_params.get("filter_id")
        if not filter_id:
            return func.HttpResponse("Missing filter_id", status_code=400)

        conn = get_connection()
        cursor = conn.cursor()

        # Get User ID
        cursor.execute("SELECT Id FROM Users WHERE B2CObjectId = ?", b2c_object_id)
        user_row = cursor.fetchone()
        if not user_row:
            return func.HttpResponse("User not found", status_code=404)

        user_id = user_row[0]

        cursor.execute("""
            DELETE FROM UserPreferenceFilters
            WHERE Id = ? AND UserId = ?
        """, (filter_id, user_id))

        if cursor.rowcount == 0:
            return func.HttpResponse("Not found or not allowed", status_code=404)

        conn.commit()
        return func.HttpResponse("Deleted", status_code=200)

    except Exception as e:
        logging.exception("USER/FILTERS DELETE: Error m30003")
        return func.HttpResponse(f"Error: {str(e)}", status_code=500)

@app.route(route="users/by-telegram/{telegram_user_id}", methods=["GET"])
def get_user_by_telegram(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('USERS/BY-TELEGRAM processed a request.')

    try:
        if not require_bot_key(req):
            return func.HttpResponse("Unauthorized", status_code=401)

        tg_id_raw = req.route_params.get("telegram_user_id")
        if not tg_id_raw:
            return func.HttpResponse("Missing telegram_user_id", status_code=400)

        try:
            tg_id = int(tg_id_raw)
        except ValueError:
            return func.HttpResponse("telegram_user_id must be integer", status_code=400)

        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT Id, Email, Username, Role
            FROM Users
            WHERE TelegramUserId = ?
        """, tg_id)
        row = cursor.fetchone()

        if not row:
            return func.HttpResponse("Not found", status_code=404)

        user_id, email, username, role = row
        data = {
            "userId": str(user_id),
            "email": email,
            "username": username,
            "role": role
        }
        return func.HttpResponse(json.dumps(data), status_code=200, mimetype="application/json")

    except Exception as e:
        logging.exception("USER/BY-TELEGRAM: Error t10001")
        return func.HttpResponse(f"Error: {str(e)}", status_code=500)

@app.route(route="users/link-telegram", methods=["POST"])
def link_telegram(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('USERS/LINK-TELEGRAM processed a request.')

    try:
        if not require_bot_key(req):
            return func.HttpResponse("Unauthorized", status_code=401)

        data = req.get_json()
        code = data.get("code")
        telegram_user_id = data.get("telegram_user_id")

        if not code or telegram_user_id is None:
            return func.HttpResponse("Missing code or telegram_user_id", status_code=400)

        try:
            tg_id = int(telegram_user_id)
        except (TypeError, ValueError):
            return func.HttpResponse("telegram_user_id must be integer", status_code=400)

        conn = get_connection()
        cursor = conn.cursor()

        # Find by link code
        cursor.execute("""
            SELECT Id, TelegramUserId
            FROM Users
            WHERE TelegramLinkCode = ?
        """, code)
        row = cursor.fetchone()
        if not row:
            return func.HttpResponse("Invalid or expired code", status_code=404)

        user_id, existing_tg = row

        # Already linked?
        if existing_tg is not None:
            if existing_tg == tg_id:
                # Idempotent success
                result = { "userId": str(user_id), "message": "Already linked" }
                return func.HttpResponse(json.dumps(result), status_code=200, mimetype="application/json")
            else:
                return func.HttpResponse("Account already linked to a different Telegram user", status_code=409)

        # Perform the link + consume the code
        cursor.execute("""
            UPDATE Users
            SET TelegramUserId = ?, TelegramLinkedAt = SYSDATETIME(), TelegramLinkCode = NULL
            WHERE Id = ?
        """, (tg_id, user_id))
        conn.commit()

        result = { "userId": str(user_id), "message": "Linked" }
        return func.HttpResponse(json.dumps(result), status_code=200, mimetype="application/json")

    except ValueError:
        return func.HttpResponse("Invalid JSON", status_code=400)
    except Exception as e:
        logging.exception("USER/LINK-TELEGRAM: Error t20001")
        return func.HttpResponse(f"Error: {str(e)}", status_code=500)

import secrets
import string

def _generate_code(n: int = 8) -> str:
    alphabet = string.ascii_uppercase + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(n))

@app.route(route="users/link-code", methods=["GET"])
def get_or_create_link_code(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('USERS/LINK-CODE processed a request.')

    try:
        b2c_object_id = req.headers.get("x-user-sub")
        if not b2c_object_id:
            return func.HttpResponse("Unauthorized", status_code=401)

        conn = get_connection()
        cursor = conn.cursor()

        cursor.execute("""
            SELECT Id, TelegramUserId, TelegramLinkCode
            FROM Users
            WHERE B2CObjectId = ?
        """, b2c_object_id)
        row = cursor.fetchone()

        if not row:
            return func.HttpResponse("User not found", status_code=404)

        user_id, tg_user_id, code = row

        if tg_user_id is not None:
            payload = {
                "linked": True,
                "telegramUserId": int(tg_user_id)
            }
            return func.HttpResponse(json.dumps(payload), status_code=200, mimetype="application/json")

        # Ensure a code exists
        if not code:
            # generate unique code (retry if collision)
            for _ in range(5):
                new_code = _generate_code(8)
                try:
                    cursor.execute("""
                        UPDATE Users
                        SET TelegramLinkCode = ?
                        WHERE Id = ? AND TelegramLinkCode IS NULL
                    """, (new_code, user_id))
                    if cursor.rowcount == 1:
                        conn.commit()
                        code = new_code
                        break
                except Exception:
                    # If unique index collision occurs, retry
                    conn.rollback()
            if not code:
                return func.HttpResponse("Failed to generate code", status_code=500)

        payload = {
            "linked": False,
            "code": code
        }
        return func.HttpResponse(json.dumps(payload), status_code=200, mimetype="application/json")

    except Exception as e:
        logging.exception("USER/LINK-CODE: Error t30001")
        return func.HttpResponse(f"Error: {str(e)}", status_code=500)

@app.route(route="users/unlink-telegram", methods=["POST"])
def unlink_telegram(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('USERS/UNLINK-TELEGRAM processed a request.')

    try:
        if not require_bot_key(req):
            return func.HttpResponse("Unauthorized", status_code=401)

        data = req.get_json() or {}
        tg_id = data.get("telegram_user_id")
        b2c_obj = data.get("b2c_object_id")

        if tg_id is None and not b2c_obj:
            return func.HttpResponse("Provide telegram_user_id or b2c_object_id", status_code=400)

        conn = get_connection()
        cursor = conn.cursor()

        if tg_id is not None:
            try:
                tg_id = int(tg_id)
            except (TypeError, ValueError):
                return func.HttpResponse("telegram_user_id must be integer", status_code=400)
            # Unlink by TelegramUserId
            cursor.execute("""
                UPDATE Users
                SET TelegramUserId = NULL,
                    TelegramLinkedAt = NULL
                WHERE TelegramUserId = ?
            """, tg_id)
            affected = cursor.rowcount
            conn.commit()
            return func.HttpResponse(json.dumps({"unlinked": affected}), status_code=200, mimetype="application/json")

        # else unlink by B2C object id
        cursor.execute("""
            UPDATE Users
            SET TelegramUserId = NULL,
                TelegramLinkedAt = NULL
            WHERE B2CObjectId = ?
        """, b2c_obj)
        affected = cursor.rowcount
        conn.commit()
        return func.HttpResponse(json.dumps({"unlinked": affected}), status_code=200, mimetype="application/json")

    except ValueError:
        return func.HttpResponse("Invalid JSON", status_code=400)
    except Exception as e:
        logging.exception("USER/UNLINK-TELEGRAM: Error t40001")
        return func.HttpResponse(f"Error: {str(e)}", status_code=500)