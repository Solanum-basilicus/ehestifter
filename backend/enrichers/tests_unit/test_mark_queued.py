"""Test queued-state changes without a live dispatcher or worker."""

import unittest
from unittest.mock import patch

from helpers.runs_create import mark_queued_by_gateway


class FakeCursor:
    def __init__(self, status):
        self.status = status
        self.queries = []

    def execute(self, sql, *params):
        self.queries.append((sql, params))
        return self

    def fetchone(self):
        if self.status is None:
            return None
        return (self.status,)


class FakeConnection:
    def __init__(self, status):
        self.cur = FakeCursor(status)
        self.commits = 0
        self.rollbacks = 0

    def cursor(self):
        return self.cur

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        pass


class MarkQueuedTests(unittest.TestCase):
    def _call(self, status):
        conn = FakeConnection(status)
        with patch("helpers.runs_create.get_connection", return_value=conn):
            result = mark_queued_by_gateway("run-1")
        return result, conn

    def test_pending_changes_to_queued(self):
        result, conn = self._call("Pending")
        self.assertEqual(result, ("Queued", True))
        self.assertEqual(conn.commits, 1)
        self.assertTrue(any(
            "SET Status = 'Queued'" in sql and "Status = 'Pending'" in sql
            for sql, _ in conn.cur.queries
        ))

    def test_queued_is_noop(self):
        result, conn = self._call("Queued")
        self.assertEqual(result, ("Queued", False))
        self.assertEqual(conn.commits, 1)
        self.assertFalse(any("UPDATE" in sql for sql, _ in conn.cur.queries))

    def test_other_states_are_not_changed(self):
        for status in ("Leased", "Succeeded", "Failed", "Superseded", "Expired"):
            with self.subTest(status=status):
                result, conn = self._call(status)
                self.assertEqual(result, (status, False))
                self.assertEqual(conn.commits, 1)
                self.assertFalse(any("UPDATE" in sql for sql, _ in conn.cur.queries))

    def test_unknown_run_is_rejected(self):
        conn = FakeConnection(None)
        with patch("helpers.runs_create.get_connection", return_value=conn):
            with self.assertRaisesRegex(ValueError, "Run not found"):
                mark_queued_by_gateway("unknown")
        self.assertEqual(conn.commits, 0)
        self.assertEqual(conn.rollbacks, 1)


if __name__ == "__main__":
    unittest.main()
