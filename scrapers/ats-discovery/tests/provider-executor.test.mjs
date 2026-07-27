import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDiscoveryPolicy } from '../src/policy/discovery-policy.mjs';
import { executeProviderTargets } from '../src/scan/provider-executor.mjs';

function policy({
  concurrency = 2,
  interval = 0,
  rateLimitThreshold = 2,
  transientThreshold = 8,
  ratioThreshold = 0.5,
  minimumRatioRequests = 10,
} = {}) {
  return parseDiscoveryPolicy({
    schema_version: 1,
    defaults: {
      execution: {
        concurrency,
        min_request_interval_ms: interval,
        breaker: {
          rate_limit_threshold: rateLimitThreshold,
          transient_error_threshold: transientThreshold,
          transient_error_ratio_threshold: ratioThreshold,
          minimum_requests_for_ratio: minimumRatioRequests,
          cooldown_minutes: 1440,
        },
      },
    },
    providers: { ashby: {} },
  });
}

function target(sequence, targetClass = 'normal', tenant = `tenant-${sequence}`) {
  return { sequence, provider: 'ashby', tenant, targetClass };
}

function httpError(status) {
  const error = new Error(`HTTP ${status}`);
  error.status = status;
  return error;
}

test('priority targets complete before normal targets begin', async () => {
  const events = [];
  const result = await executeProviderTargets({
    targets: [target(0, 'priority'), target(1, 'priority'), target(2, 'normal')],
    policy: policy(),
    globalConcurrency: 2,
    fetchTarget: async (item) => {
      events.push(`start:${item.sequence}`);
      await Promise.resolve();
      events.push(`end:${item.sequence}`);
      return [];
    },
  });
  const normalStart = events.indexOf('start:2');
  assert.ok(normalStart > events.indexOf('end:0'));
  assert.ok(normalStart > events.indexOf('end:1'));
  assert.equal(result.batches.length, 3);
});

test('per-provider concurrency is enforced below global concurrency', async () => {
  let active = 0;
  let maxActive = 0;
  const releases = [];
  const running = executeProviderTargets({
    targets: [target(0), target(1), target(2), target(3)],
    policy: policy({ concurrency: 2 }),
    globalConcurrency: 4,
    fetchTarget: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => releases.push(resolve));
      active -= 1;
      return [];
    },
  });
  while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maxActive, 2);
  releases.splice(0).forEach((release) => release());
  while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
  releases.splice(0).forEach((release) => release());
  await running;
  assert.equal(maxActive, 2);
});

test('minimum request interval paces starts for the same provider', async () => {
  let clock = 0;
  const sleeps = [];
  const starts = [];
  await executeProviderTargets({
    targets: [target(0), target(1), target(2)],
    policy: policy({ concurrency: 1, interval: 100 }),
    globalConcurrency: 1,
    monotonicNow: () => clock,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
    fetchTarget: async () => {
      starts.push(clock);
      return [];
    },
  });
  assert.deepEqual(starts, [0, 100, 200]);
  assert.deepEqual(sleeps, [100, 100]);
});

test('two rate limits open the provider circuit and skip remaining targets', async () => {
  let calls = 0;
  const result = await executeProviderTargets({
    targets: [target(0), target(1), target(2), target(3)],
    policy: policy({ concurrency: 1, rateLimitThreshold: 2 }),
    globalConcurrency: 1,
    fetchTarget: async () => {
      calls += 1;
      throw httpError(429);
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.breakerEvents[0].reason, 'rate_limit_threshold');
  assert.deepEqual(
    result.batches.map((item) => item.providerResult.status),
    ['error', 'error', 'skipped', 'skipped'],
  );
});

test('repeated 404 tenant failures do not open a provider-wide circuit', async () => {
  let calls = 0;
  const result = await executeProviderTargets({
    targets: Array.from({ length: 5 }, (_, index) => target(index)),
    policy: policy({ concurrency: 1, transientThreshold: 2 }),
    globalConcurrency: 1,
    fetchTarget: async () => {
      calls += 1;
      throw httpError(404);
    },
  });
  assert.equal(calls, 5);
  assert.equal(result.breakerEvents.length, 0);
  assert.equal(result.batches.every((item) => item.providerResult.httpStatus === 404), true);
});

test('transient error threshold opens the circuit', async () => {
  const error = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
  const result = await executeProviderTargets({
    targets: [target(0), target(1), target(2)],
    policy: policy({ concurrency: 1, transientThreshold: 2 }),
    globalConcurrency: 1,
    fetchTarget: async () => { throw error; },
  });
  assert.equal(result.breakerEvents[0].reason, 'transient_error_threshold');
  assert.equal(result.batches[2].providerResult.status, 'skipped');
});

test('transient error ratio opens only after the minimum sample', async () => {
  let index = 0;
  const result = await executeProviderTargets({
    targets: Array.from({ length: 6 }, (_, i) => target(i)),
    policy: policy({
      concurrency: 1,
      transientThreshold: 100,
      ratioThreshold: 0.5,
      minimumRatioRequests: 4,
    }),
    globalConcurrency: 1,
    fetchTarget: async () => {
      index += 1;
      if (index % 2 === 0) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      return [];
    },
  });
  assert.equal(result.breakerEvents[0].reason, 'transient_error_ratio');
  assert.equal(result.breakerEvents[0].requestsAttempted, 4);
  assert.equal(result.batches[4].providerResult.status, 'skipped');
});

test('non-array provider output is a schema error and participates in breaker policy', async () => {
  const result = await executeProviderTargets({
    targets: [target(0), target(1)],
    policy: policy({ concurrency: 1, transientThreshold: 1 }),
    globalConcurrency: 1,
    fetchTarget: async () => ({ jobs: [] }),
  });
  assert.equal(result.batches[0].providerResult.errorClass, 'provider_error');
  assert.equal(result.breakerEvents[0].reason, 'transient_error_threshold');
  assert.equal(result.batches[1].providerResult.status, 'skipped');
});

test('provider result includes status code and bounded diagnostics', async () => {
  const error = httpError(503);
  error.message = 'x'.repeat(1000);
  const result = await executeProviderTargets({
    targets: [target(0)],
    policy: policy(),
    globalConcurrency: 1,
    fetchTarget: async () => { throw error; },
  });
  const providerResult = result.batches[0].providerResult;
  assert.equal(providerResult.errorClass, 'http_5xx');
  assert.equal(providerResult.httpStatus, 503);
  assert.equal(providerResult.errorMessage.length, 500);
});

test('results are returned in target sequence order', async () => {
  const result = await executeProviderTargets({
    targets: [target(7), target(2), target(5)],
    policy: policy(),
    globalConcurrency: 3,
    fetchTarget: async (item) => {
      await new Promise((resolve) => setTimeout(resolve, 8 - item.sequence));
      return [];
    },
  });
  assert.deepEqual(result.batches.map((item) => item.target.sequence), [2, 5, 7]);
});
