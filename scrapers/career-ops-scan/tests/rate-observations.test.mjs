import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDiscoveryPolicy } from '../src/policy/discovery-policy.mjs';
import { buildRateObservations } from '../src/scan/rate-observations.mjs';

function policy({ concurrency = 3, interval = 150 } = {}) {
  return parseDiscoveryPolicy({
    schema_version: 1,
    defaults: {
      execution: { concurrency, min_request_interval_ms: interval },
      recommendations: {
        minimum_requests: 4,
        healthy_success_ratio: 0.75,
        high_transient_error_ratio: 0.25,
        fast_p95_ms: 5000,
        maximum_suggested_concurrency: 8,
      },
    },
    providers: { ashby: {} },
  });
}

function result(overrides = {}) {
  return {
    sequence: 0,
    provider: 'ashby',
    tenant: 'example',
    targetClass: 'normal',
    status: 'ok',
    skipReason: null,
    errorClass: null,
    errorMessage: null,
    httpStatus: null,
    jobsReturned: 10,
    candidatesRetained: 1,
    durationMs: 100,
    ...overrides,
  };
}

test('rate observations aggregate provider counts and latency percentiles', () => {
  const observations = buildRateObservations({
    providerResults: [
      result({ sequence: 0, durationMs: 100 }),
      result({ sequence: 1, durationMs: 200 }),
      result({ sequence: 2, durationMs: 300 }),
      result({ sequence: 3, durationMs: 400 }),
    ],
    policy: policy(),
    targetPlan: { sweep: { recommendedNormalTargetsPerRun: 1000 } },
    generatedAt: new Date('2026-07-20T00:00:00Z'),
  });
  const ashby = observations.providers[0];
  assert.equal(ashby.requestsAttempted, 4);
  assert.equal(ashby.successes, 4);
  assert.equal(ashby.jobsReturned, 40);
  assert.deepEqual(ashby.latencyMs, {
    min: 100,
    average: 250,
    p50: 200,
    p95: 400,
    max: 400,
  });
  assert.equal(observations.sweep.recommendedNormalTargetsPerRun, 1000);
});

test('404 and 410 are counted as durable tenant failures, not transient errors', () => {
  const observations = buildRateObservations({
    providerResults: [
      result({ status: 'error', errorClass: 'http_4xx', httpStatus: 404 }),
      result({ status: 'error', errorClass: 'http_4xx', httpStatus: 410 }),
    ],
    policy: policy(),
  });
  const ashby = observations.providers[0];
  assert.equal(ashby.durableTenantFailures, 2);
  assert.equal(ashby.transientErrors, 0);
  assert.equal(ashby.recommendation.action, 'hold');
});

test('skipped circuit targets are not counted as requests', () => {
  const observations = buildRateObservations({
    providerResults: [
      result(),
      result({ status: 'skipped', skipReason: 'provider_circuit_open', durationMs: 0 }),
    ],
    policy: policy(),
  });
  const ashby = observations.providers[0];
  assert.equal(ashby.targetsPlanned, 2);
  assert.equal(ashby.requestsAttempted, 1);
  assert.equal(ashby.skippedByCircuit, 1);
});

test('rate limit recommends lower concurrency and more pacing', () => {
  const observations = buildRateObservations({
    providerResults: [
      result({ status: 'error', errorClass: 'rate_limited', httpStatus: 429 }),
    ],
    breakerEvents: [{ provider: 'ashby', reason: 'rate_limit_threshold' }],
    policy: policy({ concurrency: 3, interval: 100 }),
  });
  const recommendation = observations.providers[0].recommendation;
  assert.equal(recommendation.action, 'decrease');
  assert.equal(recommendation.suggestedConcurrency, 2);
  assert.ok(recommendation.suggestedMinRequestIntervalMs > 100);
});

test('high transient error ratio recommends decrease without auto-applying it', () => {
  const observations = buildRateObservations({
    providerResults: [
      result({ sequence: 0 }),
      result({ sequence: 1 }),
      result({ sequence: 2, status: 'error', errorClass: 'network' }),
      result({ sequence: 3, status: 'error', errorClass: 'http_5xx', httpStatus: 503 }),
    ],
    policy: policy({ concurrency: 4 }),
  });
  const ashby = observations.providers[0];
  assert.equal(ashby.transientErrors, 2);
  assert.equal(ashby.recommendation.action, 'decrease');
  assert.equal(ashby.policy.concurrency, 4);
});

test('healthy sufficiently large fast sample suggests reviewable increase', () => {
  const observations = buildRateObservations({
    providerResults: Array.from({ length: 4 }, (_, sequence) => result({
      sequence,
      durationMs: 1000 + sequence,
    })),
    policy: policy({ concurrency: 3 }),
  });
  const recommendation = observations.providers[0].recommendation;
  assert.equal(recommendation.action, 'consider_increase');
  assert.equal(recommendation.suggestedConcurrency, 4);
});

test('small sample recommends hold', () => {
  const observations = buildRateObservations({
    providerResults: [result()],
    policy: policy(),
  });
  assert.equal(observations.providers[0].recommendation.action, 'hold');
  assert.match(observations.providers[0].recommendation.rationale, /Not enough/);
});

test('multiple providers are reported independently and sorted', () => {
  const observations = buildRateObservations({
    providerResults: [
      result({ provider: 'lever' }),
      result({ provider: 'ashby' }),
    ],
    policy: policy(),
  });
  assert.deepEqual(observations.providers.map((item) => item.provider), ['ashby', 'lever']);
});
