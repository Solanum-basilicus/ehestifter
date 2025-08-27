import json
import logging
import azure.functions as func
from helpers.db import get_connection
from helpers.guid import normalize_guid
from helpers.security import require_bot_key

def register(app):
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
                "userId": normalize_guid(user_id),
                "email": email,
                "username": username,
                "role": role
            }
            return func.HttpResponse(json.dumps(data), status_code=200, mimetype="application/json")

        except Exception as e:
            logging.exception("USER/BY-TELEGRAM: Error t10001")
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)