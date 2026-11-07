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

test('summary counts successful pool reuse and bounded latency percentiles', () => {
  const summary = compatibilityDiagnosticsSummary({ results: [
    { status: 'requested', requestDiagnostics: {
      httpStatus: 201, attempts: 1, failedAttempts: [],
      poolAction: 'new', poolLeases: { new: 1, hit: 2, replaced: 0, disabled: 0 },
      timingMs: { app: 200, dbconn: 170, db_open: 170, sql: 4 },
    } },
    { status: 'skipped_reused', requestDiagnostics: {
      httpStatus: 200, attempts: 2,
      failedAttempts: [{ httpStatus: 500, category: 'http_server_error',
        poolAction: 'new', serverFailure: {
          stage: 'run_create', category: 'db_connection_operational', sqlState: 'HYT00',
        } }],
      poolAction: 'hit', poolLeases: { hit: 4, new: 0, replaced: 0, disabled: 0 },
      timingMs: { app: 5, dbconn: 0.02, db_open: 0, sql: 1 },
    } },
    { status: 'error_request', requestDiagnostics: {
      httpStatus: null, attempts: 1, failedAttempts: [{ httpStatus: null,
        category: 'transport_timeout' }],
    } },
  ] });
  assert.deepEqual(summary.poolActions, { hit: 1, new: 2 });
  assert.deepEqual(summary.poolLeases, { hit: 6, new: 1, replaced: 0, disabled: 0 });
  assert.equal(summary.successfulRequestTiming.dbconn.count, 2);
  assert.equal(summary.successfulRequestTiming.dbconn.p50Ms, 0.02);
  assert.equal(summary.successfulRequestTiming.dbconn.p95Ms, 170);
  assert.deepEqual(summary.sqlStateCounts, { HYT00: 1 });
  assert.equal(summary.recoveredRetryPairs, 1);
});
