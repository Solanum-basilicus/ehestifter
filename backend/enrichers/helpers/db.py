"""SQL connections for Enrichment Core and its timers.

Each caller has an exclusive lease. The pool is local to a Python worker.
"""

import os
import re
from time import perf_counter

import pyodbc

from helpers.sql_pool import ConnectionLease, ConnectionPool, PoolWaitTimeout
from helpers.timing import TimedConnection, current, record_db_failure


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


def _integer_setting(name, default, minimum, maximum):
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError as exc:
        raise ValueError(f"Invalid setting: {name}") from exc
    if not minimum <= value <= maximum:
        raise ValueError(f"Invalid setting: {name}")
    return value


_enabled = os.getenv("ENRICHERS_SQL_POOL_ENABLED", "true").strip().lower()
if _enabled not in ("true", "1", "yes", "false", "0", "no"):
    raise ValueError("Invalid setting: ENRICHERS_SQL_POOL_ENABLED")
POOL_ENABLED = _enabled in ("true", "1", "yes")
if POOL_ENABLED:
    # Set this before any SQL connection in the worker.
    pyodbc.pooling = False


class _DirectCloser:
    @staticmethod
    def release(connection):
        connection.close()

    discard = release


_direct_closer = _DirectCloser()
_pool = ConnectionPool(
    max_size=_integer_setting("ENRICHERS_SQL_POOL_SIZE", 4, 1, 16),
    idle_seconds=_integer_setting("ENRICHERS_SQL_POOL_IDLE_SECONDS", 120, 1, 600),
    validation_seconds=_integer_setting("ENRICHERS_SQL_POOL_VALIDATE_SECONDS", 30, 0, 600),
    wait_seconds=_integer_setting("ENRICHERS_SQL_POOL_WAIT_SECONDS", 2, 0, 30),
)


def _validate(connection):
    previous_timeout = connection.timeout
    connection.timeout = 2
    cursor = None
    try:
        # A pyodbc cursor gets the timeout when created.
        cursor = connection.cursor()
        cursor.execute("SELECT 1")
        cursor.fetchone()
    finally:
        try:
            if cursor is not None:
                cursor.close()
        finally:
            connection.timeout = previous_timeout
            connection.rollback()


def get_connection():
    measure = current()
    started = perf_counter()

    def observe(key, duration):
        if measure is not None:
            measure.values[key] = measure.values.get(key, 0) + duration

    try:
        if POOL_ENABLED:
            connection, action = _pool.acquire(
                lambda: pyodbc.connect(SQL_CONN_STR, timeout=5), _validate, observe,
            )
        else:
            open_started = perf_counter()
            try:
                connection = ConnectionLease(
                    _direct_closer, pyodbc.connect(SQL_CONN_STR, timeout=5),
                )
            finally:
                observe("db_open", (perf_counter() - open_started) * 1000)
            action = "disabled"
        if measure is not None:
            measure.labels["db_pool"] = action
            measure.pool_leases[action] += 1
            measure.connections.append(connection)
        # Also wrap timer SQL calls so broken SQL sockets are discarded.
        return TimedConnection(connection, measure)
    except PoolWaitTimeout as exc:
        record_db_failure("db_acquire", "pool_wait_timeout", exc)
        raise DatabaseConnectionError("pool_wait") from None
    except pyodbc.InterfaceError as exc:
        record_db_failure("db_acquire", "db_connection_interface", exc)
        raise DatabaseConnectionError("interface", sql_state(exc)) from None
    except pyodbc.OperationalError as exc:
        record_db_failure("db_acquire", "db_connection_operational", exc)
        raise DatabaseConnectionError("operational", sql_state(exc)) from None
    except DatabaseConnectionError:
        raise
    except Exception as exc:
        record_db_failure("db_acquire", "db_connection_unexpected", exc)
        raise DatabaseConnectionError("unexpected") from None
    finally:
        observe("dbconn", (perf_counter() - started) * 1000)
