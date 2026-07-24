import assert from 'node:assert/strict';
import test from 'node:test';

import { createEnrichmentClient } from '../src/ehestifter/enrichment-client.mjs';

const JOB = '33333333-3333-4333-8333-333333333333';
const USER = '11111111-1111-4111-8111-111111111111';

test('latest 404 becomes null and create uses the existing Enrichment route', async () => {
  const requests = [];
  const client = createEnrichmentClient({
    baseUrl: 'https://enrichers.example/api',
    functionKey: 'secret',
    timeoutMs: 1000,
    retryCount: 0,
  }, {
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (options.method === 'GET') return new Response('Not found', { status: 404 });
      return new Response(JSON.stringify({ runId: 'run-1', status: 'Queued' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(await client.getLatest(JOB, USER, 'compatibility.v1'), null);
  const run = await client.createRun(JOB, USER, 'compatibility.v1');
  assert.equal(run.runId, 'run-1');
  assert.match(requests[0].url, /enrichment\/subjects/);
  assert.equal(requests[0].options.headers['x-functions-key'], 'secret');
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    jobOfferingId: JOB,
    userId: USER,
    enricherType: 'compatibility.v1',
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
    client.getLatest(JOB, USER, 'compatibility.v1'),
    /JSON|Unexpected token|Unexpected end/,
  );
  assert.equal(attempts, 1);
});
