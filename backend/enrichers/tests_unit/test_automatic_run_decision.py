"""Test automatic run decisions without accessing the production database."""
from __future__ import annotations

import unittest
from unittest.mock import patch

from helpers.runs_create import create_run_db, decide_automatic_run


class FakeCursor:
    def __init__(self, cv='cv-1', latest=None, lock_result=0):
        self.cv = cv
        self.latest = latest
        self.lock_result = lock_result
        self.queries = []
        self.last_query = ''

    def execute(self, sql, *args):
        self.queries.append((sql, args))
        self.last_query = sql
        return self

    def fetchone(self):
        if 'sp_getapplock' in self.last_query:
            return (self.lock_result,)
        if 'SELECT CVVersionId' in self.last_query:
            return (self.cv,)
        if 'SELECT TOP 1 RunId' in self.last_query:
            return self.latest
        raise AssertionError('Unexpected fetchone')


class FakeConnection:
    def __init__(self, cursor):
        self.cur = cursor
        self.autocommit = True
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


class AutomaticRunDecisionTests(unittest.TestCase):
    def test_decision_table(self):
        cases = [
            (None, 'created'),
            ({'status': 'Pending'}, 'reused'),
            ({'status': 'Queued'}, 'reused'),
            ({'status': 'Leased'}, 'reused'),
            ({'status': 'Succeeded', 'cvVersionId': 'cv-1'}, 'reused'),
            ({'status': 'Succeeded', 'cvVersionId': None}, 'reused'),
            ({'status': 'Succeeded', 'cvVersionId': 'cv-2'}, 'created'),
            ({'status': 'Failed', 'errorCode': 'INSUFFICIENT_JOB_DESCRIPTION'}, 'suppressed'),
            ({'status': 'Failed', 'errorCode': 'INFERENCE_INVALID_RESULT'}, 'created'),
            ({'status': 'Failed', 'errorCode': 'INFERENCE_REQUEST_FAILED'}, 'created'),
            ({'status': 'Expired'}, 'created'),
        ]
        for latest, expected in cases:
            with self.subTest(latest=latest):
                self.assertEqual(decide_automatic_run(latest, 'cv-1'), expected)

    def test_automatic_reuse_does_not_supersede_or_insert(self):
        cur = FakeCursor(latest=('old-run', 'Succeeded', 'cv-1', None))
        conn = FakeConnection(cur)
        with patch('helpers.runs_create.get_connection', return_value=conn):
            run = create_run_db('job', 'user', 'compatibility.v1', request_mode='automatic')
        self.assertEqual(run, {'runId': 'old-run', 'decision': 'reused'})
        self.assertEqual(conn.commits, 1)
        self.assertFalse(any('INSERT INTO' in sql or 'UPDATE dbo' in sql for sql, _ in cur.queries))

    def test_automatic_permanent_failure_is_suppressed(self):
        cur = FakeCursor(latest=('old-run', 'Failed', 'cv-1', 'INSUFFICIENT_JOB_DESCRIPTION'))
        conn = FakeConnection(cur)
        with patch('helpers.runs_create.get_connection', return_value=conn):
            run = create_run_db('job', 'user', 'compatibility.v1', request_mode='automatic')
        self.assertEqual(run['decision'], 'suppressed')
        self.assertFalse(any('INSERT INTO' in sql for sql, _ in cur.queries))

    def test_manual_request_creates_even_after_permanent_failure(self):
        cur = FakeCursor()
        conn = FakeConnection(cur)
        with patch('helpers.runs_create.get_connection', return_value=conn):
            run = create_run_db('job', 'user', 'compatibility.v1')
        self.assertEqual(run['decision'], 'created')
        self.assertTrue(any('INSERT INTO' in sql for sql, _ in cur.queries))
        self.assertFalse(any('SELECT TOP 1 RunId' in sql for sql, _ in cur.queries))

    def test_failed_subject_lock_rolls_back(self):
        cur = FakeCursor(lock_result=-1)
        conn = FakeConnection(cur)
        with patch('helpers.runs_create.get_connection', return_value=conn):
            with self.assertRaises(RuntimeError):
                create_run_db('job', 'user', 'compatibility.v1', request_mode='automatic')
        self.assertEqual(conn.rollbacks, 1)
        self.assertEqual(conn.commits, 0)
