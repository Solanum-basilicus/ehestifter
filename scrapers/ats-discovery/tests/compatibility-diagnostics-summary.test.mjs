import assert from 'node:assert/strict';
import test from 'node:test';

import { compatibilityDiagnosticsSummary } from '../src/run-summary.mjs';

test('summary separates request failures, recovered retries and accepted Pending runs', () => {
  const summary = compatibilityDiagnosticsSummary({ results: [
    {
      status: 'requested',
      requestDiagnostics: {
        httpStatus: 201, attempts: 1, failedAttempts: [],
      },
    },
    {
      status: 'skipped_reused',
      requestDiagnostics: {
        httpStatus: 200, attempts: 2,
        failedAttempts: [{ httpStatus: 500, category: 'http_server_error' }],
      },
    },
    {
      status: 'requested',
      requestDiagnostics: {
        httpStatus: 201, attempts: 1, failedAttempts: [],
        serverFailure: { stage: 'cv_snapshot', category: 'upstream_timeout' },
      },
    },
    {
      status: 'error_request', errorCategory: 'http_server_error',
      requestDiagnostics: {
        httpStatus: 500, attempts: 2,
        failedAttempts: [
          { httpStatus: 500, category: 'http_server_error' },
          {
            httpStatus: 500, category: 'http_server_error',
            serverFailure: { stage: 'mark_queued', category: 'db_operation' },
          },
        ],
        serverFailure: { stage: 'mark_queued', category: 'db_operation' },
      },
    },
  ] });
  assert.equal(summary.path, '/enrichment/runs');
  assert.equal(summary.pairsWithDiagnostics, 4);
  assert.equal(summary.httpAttempts, 6);
  assert.equal(summary.recoveredRetryPairs, 1);
  assert.equal(summary.acceptedWithServerFailure, 1);
  assert.equal(summary.finalFailureRate, 0.25);
  assert.deepEqual(summary.httpAttemptsByStatus, { 200: 1, 201: 2, 500: 3 });
  assert.deepEqual(summary.failedAttemptsByCategory, { http_server_error: 3 });
  assert.deepEqual(summary.serverFailuresByStageAndCategory, {
    'cv_snapshot:upstream_timeout': 1,
    'mark_queued:db_operation': 1,
  });
  assert.equal(summary.byPathAndResult['/enrichment/runs:http_server_error'], 1);
  assert.equal(summary.byPathAndResult['/enrichment/runs:accepted_with_server_failure'], 1);
});
