"""SQL connection acquisition and request-local diagnostics for Jobs."""

import os
from time import perf_counter
import pyodbc

from helpers.sql_pool import ConnectionPool, ConnectionLease, PoolWaitTimeout
from helpers.timing import current, TimedConnection, record_db_failure


SQL_CONN_STR = os.getenv("SQLConnectionString")


def _integer_setting(name, default, minimum, maximum):
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError as exc:
        raise ValueError(f"Invalid setting: {name}") from exc
    if not minimum <= value <= maximum:
        raise ValueError(f"Invalid setting: {name}")
    return value


# Set this before the first ODBC connection in this Python process.
_pool_enabled_setting = os.getenv("JOBS_SQL_POOL_ENABLED", "true").strip().lower()
if _pool_enabled_setting not in ("true", "1", "yes", "false", "0", "no"):
    raise ValueError("Invalid setting: JOBS_SQL_POOL_ENABLED")
POOL_ENABLED = _pool_enabled_setting in ("true", "1", "yes")
if POOL_ENABLED:
    pyodbc.pooling = False


class _DirectCloser:
    """Keep the fallback close operation idempotent per request."""

    @staticmethod
    def release(connection):
        connection.close()

    discard = release


_direct_closer = _DirectCloser()

_pool = ConnectionPool(
    max_size=_integer_setting("JOBS_SQL_POOL_SIZE", 4, 1, 16),
    idle_seconds=_integer_setting("JOBS_SQL_POOL_IDLE_SECONDS", 120, 1, 600),
    validation_seconds=_integer_setting("JOBS_SQL_POOL_VALIDATE_SECONDS", 30, 0, 600),
    wait_seconds=_integer_setting("JOBS_SQL_POOL_WAIT_SECONDS", 2, 0, 30),
)


def _validate(connection):
    previous_timeout = connection.timeout
    connection.timeout = 2
    cursor = None
    try:
        # pyodbc copies Connection.timeout when it creates the cursor.
        cursor = connection.cursor()
        cursor.execute("SELECT 1")
        cursor.fetchone()
    finally:
        try:
            if cursor is not None:
                cursor.close()
        finally:
            connection.timeout = previous_timeout
            # Rollback also clears the validation transaction.
            connection.rollback()


def get_connection():
    measurements = current()
    started = perf_counter()

    def observe(key, duration):
        if measurements is not None:
            setattr(measurements, f"{key}_ms", getattr(measurements, f"{key}_ms") + duration)

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
            action = "new"
        if measurements is not None:
            measurements.labels["db_pool"] = action if POOL_ENABLED else "disabled"
            measurements.connections.append(connection)
        return TimedConnection(connection, measurements) if measurements is not None else connection
    except PoolWaitTimeout as exc:
        record_db_failure("db_acquire", "pool_wait_timeout", exc)
        raise Exception("Could not acquire a database connection.") from None
    except pyodbc.InterfaceError as exc:
        record_db_failure("db_acquire", "db_connection_interface", exc)
        raise Exception("Could not connect to the database.") from None
    except pyodbc.OperationalError as exc:
        record_db_failure("db_acquire", "db_connection_operational", exc)
        raise Exception("Could not connect to the database.") from None
    except Exception as exc:
        record_db_failure("db_acquire", "db_connection_unexpected", exc)
        raise Exception("Could not connect to the database.") from None
    finally:
        if measurements is not None:
            measurements.dbconn_ms += (perf_counter() - started) * 1000
