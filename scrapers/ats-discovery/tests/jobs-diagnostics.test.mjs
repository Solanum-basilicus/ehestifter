import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobsClient, preflightCandidates } from '../src/ehestifter/jobs-client.mjs';
import { preflightHttpDiagnosticsSummary } from '../src/run-summary.mjs';

const config = {
  baseUrl: 'https://jobs.example/api', functionKey: 'private-key',
  timeoutMs: 1000, retryCount: 1,
};

function existsResponse(headers = {}) {
  return new Response(JSON.stringify({
    exists: false, provider: 'ashby', providerTenant: '', externalId: '123',
  }), { status: 200, headers });
}

const candidate = { url: 'https://example.org/secret/123' };

test('preflight captures recovered Jobs errors without exposing response bodies', async () => {
  const ids = [];
  let calls = 0;
  const client = createJobsClient(config, { fetchImpl: async (_url, options) => {
    ids.push(options.headers['x-correlation-id']);
    calls += 1;
    if (calls === 1) return new Response('SECRET=private-sql-connection', {
      status: 500, headers: {
        'x-jobs-failure-stage': 'db_acquire',
        'x-jobs-failure-category': 'db_connection_operational',
        'x-jobs-failure-sqlstate': 'HYT00',
        'server-timing': 'dbconn;dur=515.25, db_open;dur=515.00, db_pool;desc="new"',
      },
    });
    return existsResponse({ 'server-timing': [
      'dbconn;dur=0.30', 'sql;dur=1.20', 'db_pool;desc="hit"',
      'process_first;desc="0"',
    ].join(', ') });
  } });
  const [item] = await preflightCandidates([candidate], client, 1);
  assert.equal(item.preflight.status, 'ok');
  assert.equal(item.preflight.requestDiagnostics.attempts, 2);
  assert.equal(item.preflight.requestDiagnostics.failedAttempts[0].serverFailure.sqlState, 'HYT00');
  assert.notEqual(ids[0], ids[1]);
  assert.match(ids[0], /^[0-9a-f-]{36}$/);
  const diagnostics = preflightHttpDiagnosticsSummary([item]);
  assert.equal(diagnostics.httpAttempts, 2);
  assert.equal(diagnostics.recoveredRetryRequests, 1);
  assert.equal(diagnostics.poolActions.hit, 1);
  assert.equal(diagnostics.serverFailuresByStageAndCategory['db_acquire:db_connection_operational'], 1);
  assert.equal(diagnostics.successfulRequestTiming.dbconn.p95Ms, 0.3);
  assert.doesNotMatch(JSON.stringify(item.preflight), /SECRET|private-sql-connection|private-key/);
});

test('normal preflight stores only essential fields, but contributes to aggregate timing', async () => {
  const client = createJobsClient({ ...config, retryCount: 0 }, {
    fetchImpl: async () => existsResponse({
      'server-timing': 'dbconn;dur=0.30, sql;dur=0.90, db_pool;desc="hit"',
    }),
  });
  const [item] = await preflightCandidates([candidate], client, 1);
  assert.deepEqual(item.preflight, { status: 'ok', exists: false });
  assert.doesNotMatch(JSON.stringify(item), /requestDiagnostics|_jobsHttpDiagnostics/);
  const stats = preflightHttpDiagnosticsSummary([item]);
  assert.equal(stats.httpAttemptsByStatus['200'], 1);
  assert.equal(stats.successfulRequestTiming.sql.p50Ms, 0.9);
  assert.equal(stats.poolActions.hit, 1);
});

test('final preflight failure keeps only safe status, SQLSTATE and correlation ID', async () => {
  const client = createJobsClient({ ...config, retryCount: 0 }, {
    fetchImpl: async () => new Response('SECRET username & password', {
      status: 500,
      headers: {
        'x-jobs-failure-stage': 'db_query',
        'x-jobs-failure-category': 'db_query_failed',
        'x-jobs-failure-sqlstate': '08S01',
        'server-timing': 'db_open;dur=123.45, db_pool;desc="replaced"',
      },
    }),
  });
  const [item] = await preflightCandidates([candidate], client, 1);
  assert.equal(item.preflight.status, 'error');
  assert.equal(item.preflight.requestDiagnostics.failedAttempts[0].serverFailure.sqlState, '08S01');
  assert.equal(item.preflight.requestDiagnostics.httpStatus, 500);
  assert.doesNotMatch(JSON.stringify(item.preflight), /SECRET|password|username/);
  const stats = preflightHttpDiagnosticsSummary([item]);
  assert.equal(stats.finalFailures, 1);
  assert.equal(stats.httpAttemptsByStatus['500'], 1);
  assert.equal(stats.sqlStateCounts['08S01'], 1);
});

test('reject untrusted diagnostic header values', async () => {
  const client = createJobsClient({ ...config, retryCount: 0 }, {
    fetchImpl: async () => new Response('no data', {
      status: 503, headers: {
        'x-jobs-failure-stage': 'db_query;password',
        'x-jobs-failure-category': 'db_query_failed',
        'x-jobs-failure-sqlstate': 'dbPWD',
        'server-timing': 'secret;dur=99, dbconn;dur=1.2, db_pool;desc="evil"',
      },
    }),
  });
  const [item] = await preflightCandidates([candidate], client, 1);
  const attempt = item.preflight.requestDiagnostics.failedAttempts[0];
  assert.equal(attempt.serverFailure, undefined);
  assert.deepEqual(attempt.timingMs, { dbconn: 1.2 });
  assert.equal(attempt.poolAction, undefined);
});

test('Jobs update omits HTTP error bodies and sends an attempt correlation ID', async () => {
  const ids = [];
  const client = createJobsClient({ ...config, retryCount: 0 }, {
    fetchImpl: async (_url, options) => {
      ids.push(options.headers['x-correlation-id']);
      return new Response('SECRET write error', { status: 400 });
    },
  });
  await assert.rejects(client.updateJobDescription('job-guid', 'description'), (error) => {
    assert.equal(error.status, 400);
    assert.doesNotMatch(error.message, /SECRET/);
    return true;
  });
  assert.match(ids[0], /^[0-9a-f-]{36}$/);
});
