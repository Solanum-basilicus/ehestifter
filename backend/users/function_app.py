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
