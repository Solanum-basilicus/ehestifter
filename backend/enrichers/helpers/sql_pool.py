"""Small process-local pool for SQL connections.

A lease belongs to one caller. The pool never shares an active connection.
"""

from dataclasses import dataclass
from threading import Condition
from time import monotonic, perf_counter


class PoolWaitTimeout(Exception):
    """No connection became free before the checkout deadline."""


@dataclass
class _Idle:
    connection: object
    returned_at: float


class ConnectionLease:
    """Return a physical connection to the pool once."""

    def __init__(self, pool, connection):
        object.__setattr__(self, "_pool", pool)
        object.__setattr__(self, "_connection", connection)
        object.__setattr__(self, "_closed", False)
        object.__setattr__(self, "_broken", False)

    def close(self):
        if self._closed:
            return
        object.__setattr__(self, "_closed", True)
        if self._broken:
            self._pool.discard(self._connection)
        else:
            self._pool.release(self._connection)

    def invalidate(self):
        object.__setattr__(self, "_broken", True)

    def __enter__(self):
        self._connection.__enter__()
        return self

    def __exit__(self, *args):
        try:
            return self._connection.__exit__(*args)
        finally:
            self.close()

    def __getattr__(self, name):
        if self._closed:
            raise RuntimeError("SQL connection lease is closed")
        return getattr(self._connection, name)

    def __setattr__(self, name, value):
        if self._closed:
            raise RuntimeError("SQL connection lease is closed")
        setattr(self._connection, name, value)


class ConnectionPool:
    def __init__(self, *, max_size=4, idle_seconds=120, validation_seconds=30,
                 wait_seconds=2, clock=monotonic):
        if max_size < 1 or idle_seconds < 0 or validation_seconds < 0 or wait_seconds < 0:
            raise ValueError("Invalid SQL pool settings")
        self.max_size = max_size
        self.idle_seconds = idle_seconds
        self.validation_seconds = validation_seconds
        self.wait_seconds = wait_seconds
        self._clock = clock
        self._condition = Condition()
        self._idle = []
        # Count all physical connections, including opens in progress.
        self._size = 0

    def _discard(self, connection):
        try:
            connection.close()
        except Exception:
            pass
        with self._condition:
            self._size -= 1
            self._condition.notify()

    def acquire(self, open_connection, validate_connection, observe=None):
        """Get one exclusive lease. Do not replay failed application SQL."""
        deadline = self._clock() + self.wait_seconds
        replaced = False
        while True:
            item = None
            open_new = False
            with self._condition:
                if self._idle:
                    item = self._idle.pop()
                elif self._size < self.max_size:
                    self._size += 1
                    open_new = True
                else:
                    remaining = deadline - self._clock()
                    if remaining <= 0:
                        raise PoolWaitTimeout("SQL pool checkout timed out")
                    start = perf_counter()
                    self._condition.wait(remaining)
                    if observe:
                        observe("db_pool_wait", (perf_counter() - start) * 1000)
                    continue

            if item is not None:
                idle_age = self._clock() - item.returned_at
                if idle_age >= self.idle_seconds:
                    self._discard(item.connection)
                    replaced = True
                    continue
                if idle_age >= self.validation_seconds:
                    start = perf_counter()
                    try:
                        validate_connection(item.connection)
                    except Exception:
                        self._discard(item.connection)
                        replaced = True
                        continue
                    finally:
                        if observe:
                            observe("db_validate", (perf_counter() - start) * 1000)
                return ConnectionLease(self, item.connection), ("replaced" if replaced else "hit")

            if open_new:
                start = perf_counter()
                try:
                    connection = open_connection()
                except BaseException:
                    with self._condition:
                        self._size -= 1
                        self._condition.notify()
                    raise
                finally:
                    if observe:
                        observe("db_open", (perf_counter() - start) * 1000)
                return ConnectionLease(self, connection), ("replaced" if replaced else "new")

    def discard(self, connection):
        self._discard(connection)

    def release(self, connection):
        # Roll back work before the lease is given to another caller.
        try:
            if getattr(connection, "autocommit", False):
                # Autocommit statements have no pending transaction.
                connection.autocommit = False
            else:
                connection.rollback()
            # A previous route can set a query timeout on the connection.
            connection.timeout = 0
        except Exception:
            self._discard(connection)
            return
        with self._condition:
            self._idle.append(_Idle(connection, self._clock()))
            self._condition.notify()
