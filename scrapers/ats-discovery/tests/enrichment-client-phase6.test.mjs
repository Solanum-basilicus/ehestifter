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
    /JSON|Unexpected token|Unexpected end/,
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
