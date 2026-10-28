import logging
import os
import pyodbc
from time import perf_counter
from helpers.timing import current, TimedConnection

SQL_CONN_STR = os.getenv("SQL_CONNECTION_STRING")

def get_connection():
    measure = current()
    started = perf_counter() if measure is not None else None
    try:
        conn = pyodbc.connect(SQL_CONN_STR, timeout=5)
        return TimedConnection(conn, measure) if measure is not None else conn
    except pyodbc.InterfaceError as e:
        logging.error("SQL InterfaceError during connect: %s", e)
        raise Exception("Could not connect to the database: network issue or driver failure.")
    except pyodbc.OperationalError as e:
        logging.error("SQL OperationalError during connect: %s", e)
        raise Exception("Could not connect to the database: invalid credentials or timeout.")
    except Exception as e:
        logging.exception("Unhandled database connection error")
        raise Exception("Unexpected error while connecting to the database.")
    finally:
        if measure is not None:
            measure.dbconn_ms += (perf_counter() - started) * 1000
