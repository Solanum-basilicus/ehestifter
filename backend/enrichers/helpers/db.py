# db.py
import os
import logging
import pyodbc

SQL_CONN_STR = os.getenv("SQLConnectionString")

def get_connection():
    try:
        return pyodbc.connect(SQL_CONN_STR, timeout=5)
    except pyodbc.InterfaceError as e:
        logging.error("SQL InterfaceError during connect: %s", e)
        raise Exception("Could not connect to the database: network issue or driver failure.")
    except pyodbc.OperationalError as e:
        logging.error("SQL OperationalError during connect: %s", e)
        raise Exception("Could not connect to the database: invalid credentials or timeout.")
    except Exception:
        logging.exception("Unhandled database connection error")
        raise Exception("Unexpected error while connecting to the database.")
