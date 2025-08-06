import azure.functions as func
from datetime import datetime
import json
import logging
import os
import pyodbc

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
        # Extract B2CObjectId from request header
        b2c_object_id = req.headers.get("x-user-sub")  # Injected by proxy
        if not b2c_object_id:
            return func.HttpResponse("Unauthorized", status_code=401)

        conn = get_connection()
        cursor = conn.cursor()

        cursor.execute("SELECT Id FROM Users WHERE B2CObjectId = ?", b2c_object_id)
        row = cursor.fetchone()

        if row:
            user_id = str(row[0])
        else:
            cursor.execute("""
                INSERT INTO Users (B2CObjectId) OUTPUT inserted.Id VALUES (?)
            """, b2c_object_id)
            user_id = str(cursor.fetchone()[0])
            conn.commit()

        return func.HttpResponse(json.dumps({"userId": user_id}), status_code=200, mimetype="application/json")
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
