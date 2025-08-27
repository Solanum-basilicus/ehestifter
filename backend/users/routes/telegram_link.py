import json
import logging
import secrets
import string
import azure.functions as func
from helpers.db import get_connection
from helpers.guid import normalize_guid
from helpers.security import require_bot_key
from helpers.b2c_headers import get_b2c_headers

def _generate_code(n: int = 8) -> str:
    alphabet = string.ascii_uppercase + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(n))

def register(app):
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
                    result = { "userId": normalize_guid(user_id), "message": "Already linked" }
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

            result = { "userId": normalize_guid(user_id), "message": "Linked" }
            return func.HttpResponse(json.dumps(result), status_code=200, mimetype="application/json")

        except ValueError:
            return func.HttpResponse("Invalid JSON", status_code=400)
        except Exception as e:
            logging.exception("USER/LINK-TELEGRAM: Error t20001")
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)

    @app.route(route="users/link-code", methods=["GET"])
    def get_or_create_link_code(req: func.HttpRequest) -> func.HttpResponse:
        logging.info('USERS/LINK-CODE processed a request.')

        try:
            b2c_object_id, _, _ = get_b2c_headers(req)
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
                "code": code,
                "userId": normalize_guid(user_id)
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