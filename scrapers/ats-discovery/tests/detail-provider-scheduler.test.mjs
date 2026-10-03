import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDiscoveryPolicy } from '../src/policy/discovery-policy.mjs';
import { executeDetailRequests } from '../src/details/provider-scheduler.mjs';

function policy() {
  return parseDiscoveryPolicy({
    schema_version: 1,
    defaults: {
      execution: {
        concurrency: 2,
        min_request_interval_ms: 0,
      },
    },
    providers: {
      ashby: {},
      paylocity: {
        execution: {
          concurrency: 1,
          min_request_interval_ms: 1000,
        },
      },
      greenhouse: {
        execution: {
          concurrency: 1,
          min_request_interval_ms: 0,
        },
      },
    },
  });
}

function request(index, provider) {
  return { index, provider };
}

test('detail scheduler runs another provider while one provider is paced', async () => {
  let now = 0;
  const starts = [];
  const results = await executeDetailRequests({
    items: [
      request(0, 'paylocity'),
      request(1, 'paylocity'),
      request(2, 'greenhouse'),
    ],
    globalConcurrency: 2,
    policy: policy(),
    providerFor: (item) => item.provider,
    healthPartitionFor: (item) => item.provider,
    monotonicNow: () => now,
    wallNow: () => 0,
    sleep: async (milliseconds) => { now += milliseconds; },
    worker: async (item) => {
      starts.push([item.provider, item.index, now]);
      return item.index;
    },
  });

  assert.deepEqual(starts, [
    ['paylocity', 0, 0],
    ['greenhouse', 2, 0],
    ['paylocity', 1, 1000],
  ]);
  assert.deepEqual(results.map((item) => item.value), [0, 1, 2]);
});

test('detail 429 pauses that provider and retries without blocking another provider', async () => {
  let now = 0;
  const starts = [];
  let paylocityAttempts = 0;
  const results = await executeDetailRequests({
    items: [
      request(0, 'paylocity'),
      request(1, 'greenhouse'),
    ],
    globalConcurrency: 2,
    policy: policy(),
    providerFor: (item) => item.provider,
    healthPartitionFor: (item) => item.provider,
    monotonicNow: () => now,
    wallNow: () => 0,
    sleep: async (milliseconds) => { now += milliseconds; },
    worker: async (item) => {
      starts.push([item.provider, now]);
      if (item.provider === 'paylocity' && paylocityAttempts++ === 0) {
        const error = new Error('HTTP 429');
        error.status = 429;
        error.retryAfter = '2';
        throw error;
      }
      return item.provider;
    },
  });

  assert.deepEqual(starts, [
    ['paylocity', 0],
    ['greenhouse', 0],
    ['paylocity', 2000],
  ]);
  const paylocity = results.find((item) => item.provider === 'paylocity');
  assert.equal(paylocity.error, null);
  assert.equal(paylocity.attempts, 2);
  assert.equal(paylocity.rateLimitedResponses, 1);
});
