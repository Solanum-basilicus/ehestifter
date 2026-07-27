from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from helpers.enrichment_completion import CompletionRunRow, complete_run_transactionally


class FakeCursor:
    def __init__(self, run):
        self.run = run
        self.executions = []
        self._fetches = [
            (
                run.run_id,
                run.enricher_type,
                run.subject_key,
                run.job_offering_id,
                run.user_id,
                run.status,
                run.requested_at,
                run.lease_token,
                run.lease_until,
            ),
            (run.run_id,),
        ]
        self.rowcount = 1

    def execute(self, sql, *params):
        self.executions.append((sql, params))

    def fetchone(self):
        return self._fetches.pop(0)


class FakeConnection:
    def __init__(self, cursor):
        self._cursor = cursor
        self.autocommit = True
        self.committed = False
        self.rolled_back = False

    def cursor(self):
        return self._cursor

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True

    def close(self):
        pass


class EnrichmentRequeueTests(unittest.TestCase):
    def test_inference_unavailable_returns_leased_run_to_queued(self):
        run = CompletionRunRow(
            run_id="run-1",
            enricher_type="compatibility.v1",
            subject_key="job:user",
            job_offering_id="job",
            user_id="user",
            status="Leased",
            requested_at=None,
            lease_token="lease-1",
            lease_until=None,
        )
        cursor = FakeCursor(run)
        connection = FakeConnection(cursor)

        with patch("helpers.enrichment_completion.get_connection", return_value=connection):
            outcome = complete_run_transactionally(
                run_id="run-1",
                status="Failed",
                result_json=None,
                attributes_json=None,
                error_code="INFERENCE_UNAVAILABLE",
                error_message="temporary",
            )

        self.assertEqual(outcome.outcome, "requeued")
        self.assertTrue(connection.committed)
        update_sql = next(sql for sql, _ in cursor.executions if "SET Status = 'Queued'" in sql)
        self.assertIn("LeaseToken = NULL", update_sql)
        self.assertIn("LeaseUntil = NULL", update_sql)
        self.assertIn("CompletedAt = NULL", update_sql)

    def test_other_worker_failure_remains_terminal(self):
        run = CompletionRunRow(
            run_id="run-1",
            enricher_type="compatibility.v1",
            subject_key="job:user",
            job_offering_id="job",
            user_id="user",
            status="Leased",
            requested_at=None,
            lease_token="lease-1",
            lease_until=None,
        )
        cursor = FakeCursor(run)
        connection = FakeConnection(cursor)

        with patch("helpers.enrichment_completion.get_connection", return_value=connection):
            outcome = complete_run_transactionally(
                run_id="run-1",
                status="Failed",
                result_json=None,
                attributes_json=None,
                error_code="INFERENCE_REQUEST_FAILED",
                error_message="bad request",
            )

        self.assertEqual(outcome.outcome, "completed")
        terminal_updates = [sql for sql, _ in cursor.executions if "SET Status = ?" in sql]
        self.assertEqual(len(terminal_updates), 1)


if __name__ == "__main__":
    unittest.main()
