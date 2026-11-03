# db.py
import os
import re
import pyodbc

SQL_CONN_STR = os.getenv("SQLConnectionString")

def sql_state(exc):
    """Read only a valid five-character SQLSTATE, not the error message."""
    first = exc.args[0] if getattr(exc, "args", ()) else None
    return first if isinstance(first, str) and re.fullmatch(r"[A-Z0-9]{5}", first) else None


class DatabaseConnectionError(RuntimeError):
    """A safe database connection error with a fixed reason."""

    def __init__(self, reason, state=None):
        self.reason = reason
        self.sql_state = state
        super().__init__("Could not connect to the database")


def get_connection():
    try:
        return pyodbc.connect(SQL_CONN_STR, timeout=5)
    except pyodbc.InterfaceError as exc:
        raise DatabaseConnectionError("interface", sql_state(exc)) from None
    except pyodbc.OperationalError as exc:
        raise DatabaseConnectionError("operational", sql_state(exc)) from None
    except Exception:
        raise DatabaseConnectionError("unexpected") from None
