import assert from 'node:assert/strict';
import test from 'node:test';

import { createEnrichmentClient } from '../src/ehestifter/enrichment-client.mjs';

const JOB = '33333333-3333-4333-8333-333333333333';
const USER = '11111111-1111-4111-8111-111111111111';

test('create sends automatic mode to Enrichment Core', async () => {
  const requests = [];
  const client = createEnrichmentClient({
    baseUrl: 'https://enrichers.example/api',
    functionKey: 'secret',
    timeoutMs: 1000,
    retryCount: 0,
  }, {
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return new Response(JSON.stringify({ runId: 'run-1', status: 'Queued', decision: 'created' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const run = await client.createRun(JOB, USER, 'compatibility.v1');
  assert.equal(run.runId, 'run-1');
  assert.match(requests[0].url, /enrichment\/runs/);
  assert.equal(requests[0].options.headers['x-functions-key'], 'secret');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    jobOfferingId: JOB,
    userId: USER,
    enricherType: 'compatibility.v1',
    requestMode: 'automatic',
  });
});

test('successful but invalid Enrichment JSON is not retried', async () => {
  let attempts = 0;
  const client = createEnrichmentClient({
    baseUrl: 'https://enrichers.example/api',
    functionKey: 'secret',
    timeoutMs: 1000,
    retryCount: 3,
  }, {
    fetchImpl: async () => {
      attempts += 1;
      return new Response('not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  await assert.rejects(
    client.createRun(JOB, USER, 'compatibility.v1'),
    /invalid_response/,
  );
  assert.equal(attempts, 1);
});

test('failed Enrichment requests include final HTTP status and attempts', async () => {
  let attempts = 0;
  const client = createEnrichmentClient({
    baseUrl: 'https://enrichers.example/api', functionKey: 'secret',
    timeoutMs: 1000, retryCount: 1,
  }, {
    fetchImpl: async () => {
      attempts += 1;
      return new Response('unavailable', { status: 500 });
    },
  });
  await assert.rejects(client.createRun(JOB, USER, 'compatibility.v1'), (error) => {
    assert.equal(error.status, 500);
    assert.equal(error.attempts, 2);
    assert.equal(error.retriesExhausted, true);
    return true;
  });
  assert.equal(attempts, 2);
});

test('each HTTP retry gets a unique correlation ID and a safe failure record', async () => {
  const calls = [];
  const client = createEnrichmentClient({
    baseUrl: 'https://enrichers.example/api', functionKey: 'secret',
    timeoutMs: 1000, retryCount: 1,
  }, {
    fetchImpl: async (_, options) => {
      calls.push(options.headers['x-correlation-id']);
      if (calls.length === 1) {
        return new Response('CV PRIVATE MESSAGE', {
          status: 500,
          headers: {
            'x-enrichment-failure-stage': 'run_create',
            'x-enrichment-failure-category': 'db_connection_operational',
          },
        });
      }
      return new Response(JSON.stringify({ runId: 'run-1', status: 'Queued', decision: 'created' }), {
        status: 201,
      });
    },
  });
  const run = await client.createRun(JOB, USER, 'compatibility.v1');
  assert.equal(new Set(calls).size, 2);
  assert.match(calls[0], /^[0-9a-f-]{36}$/);
  assert.equal(run.requestDiagnostics.path, '/enrichment/runs');
  assert.equal(run.requestDiagnostics.attempts, 2);
  assert.equal(run.requestDiagnostics.correlationId, calls[1]);
  assert.equal(run.requestDiagnostics.failedAttempts[0].correlationId, calls[0]);
  assert.equal(run.requestDiagnostics.failedAttempts[0].category, 'http_server_error');
  assert.deepEqual(run.requestDiagnostics.failedAttempts[0].serverFailure, {
    stage: 'run_create', category: 'db_connection_operational',
  });
  assert.ok(Number.isInteger(run.requestDiagnostics.durationMs));
  assert.doesNotMatch(JSON.stringify(run), /PRIVATE/);
});

test('error diagnostics exclude server bodies and arbitrary client errors', async () => {
  const client = createEnrichmentClient({
    baseUrl: 'https://enrichers.example/api', functionKey: 'secret',
    timeoutMs: 1000, retryCount: 0,
  }, {
    fetchImpl: async () => new Response('PRIVATE CV TEXT: token abc', {
      status: 500,
      headers: {
        'x-enrichment-failure-stage': 'someone private',
        'x-enrichment-failure-category': 'password abc',
      },
    }),
  });
  await assert.rejects(client.createRun(JOB, USER, 'compatibility.v1'), (error) => {
    assert.equal(error.category, 'http_server_error');
    assert.equal(error.status, 500);
    assert.equal(error.attempts, 1);
    assert.equal(error.requestDiagnostics.failedAttempts.length, 1);
    assert.equal(error.requestDiagnostics.failedAttempts[0].serverFailure, undefined);
    assert.doesNotMatch(JSON.stringify(error.requestDiagnostics), /PRIVATE|token|password/);
    assert.doesNotMatch(error.message, /PRIVATE|token|password/);
    return true;
  });
});

test('201 accepted Pending response keeps safe server failure information', async () => {
  const client = createEnrichmentClient({
    baseUrl: 'https://enrichers.example/api', functionKey: 'secret',
    timeoutMs: 1000, retryCount: 0,
  }, {
    fetchImpl: async () => new Response(JSON.stringify({
      runId: 'run-1', status: 'Pending', decision: 'created',
    }), {
      status: 201,
      headers: {
        'x-enrichment-failure-stage': 'cv_snapshot',
        'x-enrichment-failure-category': 'upstream_timeout',
      },
    }),
  });
  const run = await client.createRun(JOB, USER, 'compatibility.v1');
  assert.deepEqual(run.requestDiagnostics.serverFailure, {
    stage: 'cv_snapshot', category: 'upstream_timeout',
  });
});

test('transport failure is redacted and retry stays bounded', async () => {
  let attempts = 0;
  const client = createEnrichmentClient({
    baseUrl: 'https://enrichers.example/api', functionKey: 'secret',
    timeoutMs: 1000, retryCount: 1,
  }, {
    fetchImpl: async () => {
      attempts += 1;
      throw Object.assign(new Error('CV body or URL must not be stored'), {
        name: 'AbortError',
      });
    },
  });
  await assert.rejects(client.createRun(JOB, USER, 'compatibility.v1'), (error) => {
    assert.equal(error.category, 'transport_timeout');
    assert.equal(error.status, null);
    assert.equal(error.requestDiagnostics.failedAttempts.length, 2);
    assert.doesNotMatch(JSON.stringify(error.requestDiagnostics), /CV body|URL/);
    return true;
  });
  assert.equal(attempts, 2);
});

test('HTTP 400 is not retried and invalid JSON does not retry', async () => {
  for (const [status, body, expected] of [
    [400, 'private body', 'http_client_error'],
    [201, 'bad json', 'invalid_response'],
  ]) {
    let attempts = 0;
    const client = createEnrichmentClient({
      baseUrl: 'https://enrichers.example/api', functionKey: 'secret',
      timeoutMs: 1000, retryCount: 3,
    }, {
      fetchImpl: async () => {
        attempts += 1;
        return new Response(body, { status });
      },
    });
    await assert.rejects(client.createRun(JOB, USER, 'compatibility.v1'), (error) => {
      assert.equal(error.category, expected);
      assert.equal(error.attempts, 1);
      return true;
    });
    assert.equal(attempts, 1);
  }
});

test('failure timing is bounded and does not store untrusted labels', async () => {
  const client = createEnrichmentClient({
    baseUrl: 'https://enrichers.example/api', functionKey: 'secret',
    timeoutMs: 1000, retryCount: 0,
  }, {
    fetchImpl: async () => new Response('PRIVATE', {
      status: 500,
      headers: {
        'x-enrichment-failure-stage': 'run_create',
        'x-enrichment-failure-category': 'db_sql',
        'x-enrichment-failure-sqlstate': 'HYT00',
        'server-timing': 'app;dur=13.22, process_age;dur=200, '
          + 'step_run_create;dur=8.10, process_first;desc="1", '
          + 'secret;desc="PRIVATE", users_http;dur=999999999',
      },
    }),
  });
  await assert.rejects(client.createRun(JOB, USER, 'compatibility.v1'), (error) => {
    const item = error.requestDiagnostics.failedAttempts[0];
    assert.equal(item.serverFailure.sqlState, 'HYT00');
    assert.deepEqual(item.serverTiming, {
      timingMs: { app: 13.22, process_age: 200, step_run_create: 8.1 },
      processFirst: true,
    });
    assert.doesNotMatch(JSON.stringify(item), /PRIVATE|secret/);
    return true;
  });
});

test('Gateway status and target headers keep only allowed values', async () => {
  const client = createEnrichmentClient({
    baseUrl: 'https://enrichers.example/api', functionKey: 'secret',
    timeoutMs: 1000, retryCount: 0,
  }, {
    fetchImpl: async () => new Response('private Gateway payload', {
      status: 500,
      headers: {
        'x-enrichment-failure-stage': 'gateway_dispatch',
        'x-enrichment-failure-category': 'gateway_http_5xx',
        'x-enrichment-failure-upstream-status': '502',
        'x-enrichment-failure-gateway-target': 'alternative',
      },
    }),
  });
  await assert.rejects(client.createRun(JOB, USER, 'compatibility.v1'), (error) => {
    assert.deepEqual(error.requestDiagnostics.failedAttempts[0].serverFailure, {
      stage: 'gateway_dispatch', category: 'gateway_http_5xx',
      upstreamStatus: 502, gatewayTarget: 'alternative',
    });
    assert.doesNotMatch(JSON.stringify(error.requestDiagnostics), /private|payload/);
    return true;
  });
});

test('transport diagnostics copy only known network codes', async () => {
  const client = createEnrichmentClient({
    baseUrl: 'https://enrichers.example/api', functionKey: 'secret',
    timeoutMs: 1000, retryCount: 0,
  }, {
    fetchImpl: async () => {
      throw new TypeError('SECRET', { cause: Object.assign(new Error('PRIVATE'), {
        code: 'UND_ERR_CONNECT_TIMEOUT',
      }) });
    },
  });
  await assert.rejects(client.createRun(JOB, USER, 'compatibility.v1'), (error) => {
    assert.equal(error.category, 'transport_timeout');
    assert.equal(error.requestDiagnostics.failedAttempts[0].transportCode, 'UND_ERR_CONNECT_TIMEOUT');
    assert.doesNotMatch(JSON.stringify(error.requestDiagnostics), /SECRET|PRIVATE/);
    return true;
  });
});
