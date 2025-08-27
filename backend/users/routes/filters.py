import json
import logging
import azure.functions as func
from helpers.db import get_connection
from helpers.guid import normalize_guid, try_normalize_guid
from helpers.json import DatetimeEncoder
from helpers.b2c_headers import get_b2c_headers

def register(app):
    @app.route(route="users/filters", methods=["POST"])
    def add_user_filter(req: func.HttpRequest) -> func.HttpResponse:
        logging.info('USERS/FILTERS (POST) processed a request.')

        try:
            b2c_object_id, _, _ = get_b2c_headers(req)
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

            return func.HttpResponse(json.dumps({"filterId": normalize_guid(inserted_id)}), status_code=201, mimetype="application/json")

        except ValueError:
            return func.HttpResponse("Invalid JSON", status_code=400)
        except Exception as e:
            logging.exception("USER/FILTERS POST: Error m30001")
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)


    @app.route(route="users/filters", methods=["GET"])
    def list_user_filters(req: func.HttpRequest) -> func.HttpResponse:
        logging.info('USERS/FILTERS (GET) processed a request.')

        try:
            b2c_object_id, _, _ = get_b2c_headers(req)
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
            b2c_object_id, _, _ = get_b2c_headers(req)
            if not b2c_object_id:
                return func.HttpResponse("Unauthorized", status_code=401)

            raw_filter_id = req.route_params.get("filter_id")
            if not raw_filter_id:
                return func.HttpResponse("Missing filter_id", status_code=400)

            filter_id = try_normalize_guid(raw_filter_id)
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