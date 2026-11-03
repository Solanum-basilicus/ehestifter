"""Test the SQL pool without Azure, SQL, or network services."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest

from helpers.sql_pool import ConnectionPool, PoolWaitTimeout


class FakeConnection:
    def __init__(self, name=0, rollback_fails=False):
        self.name = name
        self.timeout = 5
        self.rollbacks = 0
        self.closed = 0
        self.rollback_fails = rollback_fails
        self.validations = 0

    def rollback(self):
        self.rollbacks += 1
        if self.rollback_fails:
            raise RuntimeError('rollback failed')

    def close(self):
        self.closed += 1

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None


def test_pool_reuses_exclusive_connection_after_rollback():
    opened = []

    def connect():
        conn = FakeConnection(len(opened))
        opened.append(conn)
        return conn

    pool = ConnectionPool(max_size=1)
    first, action = pool.acquire(connect, lambda _conn: None)
    assert action == 'new'
    physical = first._connection
    first.close()
    first.close()
    assert physical.rollbacks == 1
    assert physical.timeout == 0
    second, action = pool.acquire(connect, lambda _conn: None)
    assert action == 'hit'
    assert second._connection is physical
    assert len(opened) == 1
    with pytest.raises(RuntimeError, match='closed'):
        first.cursor()
    second.close()


def test_pool_limits_active_connections_across_threads():
    pool = ConnectionPool(max_size=1, wait_seconds=0.03)
    entered = Event()
    release = Event()
    connections = []

    def worker():
        conn, _action = pool.acquire(lambda: FakeConnection(), lambda _conn: None)
        connections.append(conn)
        entered.set()
        release.wait(1)
        conn.close()

    with ThreadPoolExecutor(max_workers=2) as executor:
        worker_future = executor.submit(worker)
        assert entered.wait(1)
        with pytest.raises(PoolWaitTimeout):
            pool.acquire(lambda: FakeConnection(), lambda _conn: None)
        assert pool._size == 1
        release.set()
        worker_future.result(timeout=2)
    assert len(connections) == 1
    lease, action = pool.acquire(lambda: FakeConnection(), lambda _conn: None)
    assert action == 'hit'
    lease.close()


def test_idle_validation_only_after_threshold():
    now = [0.0]
    pool = ConnectionPool(max_size=1, idle_seconds=120,
                          validation_seconds=30, clock=lambda: now[0])
    conn = FakeConnection()
    checked = []

    def validate(item):
        checked.append(item)

    lease, _ = pool.acquire(lambda: conn, validate)
    lease.close()
    now[0] = 29
    lease, action = pool.acquire(lambda: FakeConnection(), validate)
    assert action == 'hit'
    assert not checked
    lease.close()
    now[0] = 60
    lease, action = pool.acquire(lambda: FakeConnection(), validate)
    assert action == 'hit'
    assert checked == [conn]
    lease.close()


def test_expired_connection_is_closed_before_replacement():
    now = [0.0]
    pool = ConnectionPool(max_size=1, idle_seconds=120, clock=lambda: now[0])
    connections = []

    def connect():
        item = FakeConnection()
        connections.append(item)
        return item

    lease, _ = pool.acquire(connect, lambda _conn: None)
    lease.close()
    now[0] = 121
    lease, action = pool.acquire(connect, lambda _conn: None)
    assert action == 'replaced'
    assert connections[0].closed == 1
    assert lease._connection is connections[1]
    lease.close()


def test_invalid_idle_connection_is_discarded_and_replaced():
    now = [0.0]
    pool = ConnectionPool(max_size=1, idle_seconds=120,
                          validation_seconds=30, clock=lambda: now[0])
    connections = []

    def connect():
        item = FakeConnection()
        connections.append(item)
        return item

    lease, _ = pool.acquire(connect, lambda _conn: None)
    lease.close()
    now[0] = 31

    def invalid(_conn):
        raise RuntimeError('stale connection')

    lease, action = pool.acquire(connect, invalid)
    assert action == 'replaced'
    assert connections[0].closed == 1
    assert len(connections) == 2
    lease.close()


def test_failed_rollback_disposes_connection():
    pool = ConnectionPool(max_size=1)
    broken = FakeConnection(rollback_fails=True)
    first, _ = pool.acquire(lambda: broken, lambda _conn: None)
    first.close()
    assert broken.closed == 1
    replacement, action = pool.acquire(FakeConnection, lambda _conn: None)
    assert action == 'new'
    assert replacement._connection is not broken
    replacement.close()


def test_failed_open_returns_capacity_to_pool():
    pool = ConnectionPool(max_size=1)

    def fail():
        raise RuntimeError('connection error')

    with pytest.raises(RuntimeError):
        pool.acquire(fail, lambda _conn: None)
    assert pool._size == 0
    lease, action = pool.acquire(FakeConnection, lambda _conn: None)
    assert action == 'new'
    lease.close()


def test_invalid_lease_is_closed_without_return_to_idle_pool():
    pool = ConnectionPool(max_size=1)
    physical = FakeConnection()
    lease, _ = pool.acquire(lambda: physical, lambda _conn: None)
    lease.invalidate()
    lease.close()
    assert physical.closed == 1
    assert physical.rollbacks == 0
    second, action = pool.acquire(FakeConnection, lambda _conn: None)
    assert action == 'new'
    second.close()
