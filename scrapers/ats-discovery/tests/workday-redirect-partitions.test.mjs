import test from 'node:test';
import assert from 'node:assert/strict';

import { createHttpSession } from '../src/providers/_http.mjs';
import { targetHealthIdentity } from '../src/providers/_variant.mjs';
import workday from '../src/providers/workday.mjs';
import { parseDiscoveryPolicy } from '../src/policy/discovery-policy.mjs';
import { executeProviderTargets } from '../src/scan/provider-executor.mjs';
import { buildRateObservations } from '../src/scan/rate-observations.mjs';
import { classifyProviderError, isTransientProviderResult } from '../src/scan/provider-errors.mjs';

const policy = parseDiscoveryPolicy({
  schema_version: 1,
  defaults: {
    execution: {
      concurrency: 1,
      min_request_interval_ms: 0,
      breaker: {
        rate_limit_threshold: 5,
        transient_error_threshold: 2,
        transient_error_ratio_threshold: 1,
        minimum_requests_for_ratio: 100,
        cooldown_minutes: 60,
      },
    },
  },
  providers: { ashby: {}, workday: {} },
});

function target(sequence, instance) {
  const item = {
    sequence,
    provider: 'workday',
    tenant: `company-${sequence}.${instance}.myworkdayjobs.com/External`,
    careers_url: `https://company-${sequence}.${instance}.myworkdayjobs.com/External`,
    targetClass: 'normal',
    scheduleBucket: 'healthy',
  };
  return { ...item, ...targetHealthIdentity(item) };
}

test('Workday instances form separate health partitions without changing tenant IDs', () => {
  const wd1 = target(1, 'wd1');
  const wd5 = target(2, 'wd5');
  assert.equal(wd1.providerVariant, 'wd1');
  assert.equal(wd1.healthPartition, 'workday:wd1');
  assert.equal(wd5.healthPartition, 'workday:wd5');
  assert.equal(wd1.tenant, 'company-1.wd1.myworkdayjobs.com/External');
});

test('Workday captures a manual redirect without following it or recording query secrets', async () => {
  const calls = [];
  const session = createHttpSession({
    fetchImpl: async (_url, options) => {
      calls.push(options);
      return new Response(null, {
        status: 302,
        headers: {
          location: 'https://login.example.com/auth?token=very-secret#fragment',
        },
      });
    },
  });
  let caught;
  try {
    await workday.fetch({
      name: 'Example',
      careers_url: 'https://example.wd5.myworkdayjobs.com/External',
    }, {
      ...session,
      sleep: () => { throw new Error('Redirects must not retry'); },
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].redirect, 'manual');
  assert.equal(caught.status, 302);
  assert.equal(caught.code, 'HTTP_REDIRECT');
  assert.equal(classifyProviderError(caught), 'http_redirect');
  assert.equal(caught.redirectDestination, 'https://login.example.com/auth');
  assert.doesNotMatch(JSON.stringify(caught), /very-secret/);
});

test('Workday redirects do not open a circuit for another instance', async () => {
  const targets = [target(0, 'wd1'), target(1, 'wd1'), target(2, 'wd1'),
    target(3, 'wd5'), target(4, 'wd5')];
  // Redirects remain health-significant on recovery targets.
  targets[0].scheduleBucket = 'recovery';
  const executed = [];
  const run = await executeProviderTargets({
    targets,
    policy,
    globalConcurrency: 1,
    fetchTarget: async (item) => {
      executed.push(item.sequence);
      if (item.providerVariant !== 'wd1') return [];
      const error = new Error('HTTP 302 redirect');
      error.code = 'HTTP_REDIRECT';
      error.status = 302;
      error.redirectDestination = 'https://redirect.example.test/login';
      throw error;
    },
  });
  const results = run.batches.map((batch) => batch.providerResult);
  assert.deepEqual(executed, [0, 1, 3, 4]);
  assert.deepEqual(run.breakerEvents.map((item) => item.healthPartition), ['workday:wd1']);
  assert.equal(results[2].skipReason, 'provider_circuit_open');
  assert.equal(results[0].redirectDestination, 'https://redirect.example.test/login');
  assert.equal(results[0].httpStatus, 302);
  assert.equal(results[3].status, 'ok');
  assert.equal(results[4].status, 'ok');
  assert.equal(isTransientProviderResult(results[0]), true);

  const rate = buildRateObservations({
    providerResults: results,
    breakerEvents: run.breakerEvents,
    policy,
  });
  assert.equal(rate.providers.length, 2);
  const wd1 = rate.providers.find((item) => item.healthPartition === 'workday:wd1');
  const wd5 = rate.providers.find((item) => item.healthPartition === 'workday:wd5');
  assert.equal(wd1.healthRedirects, 2);
  assert.equal(wd1.recommendation.action, 'hold');
  assert.equal(wd5.healthSuccesses, 2);
});

test('Workday tenant history moves from the legacy partition after one result', async () => {
  const { buildNextTenantState, createEmptyTenantState, tenantStateKey } = await import('../src/state/tenant-state.mjs');
  const previousTarget = {
    ...target(0, 'wd1'),
    providerVariant: null,
    healthPartition: 'workday',
  };
  const result = (item) => ({
    sequence: item.sequence,
    status: 'ok',
    provider: item.provider,
    providerVariant: item.providerVariant,
    healthPartition: item.healthPartition,
    tenant: item.tenant,
    jobsReturned: 3,
    candidatesMatched: 1,
    candidatesRetained: 1,
    durationMs: 20,
    errorClass: null,
    httpStatus: null,
    listingOutcome: 'listing_success_nonempty',
  });
  const first = buildNextTenantState({
    previousState: createEmptyTenantState(new Date('2026-10-01T00:00:00Z')),
    targets: [previousTarget],
    providerResults: [result(previousTarget)],
    rateObservations: { providers: [] },
    policy,
    finishedAt: new Date('2026-10-02T00:00:00Z'),
  });
  const moved = buildNextTenantState({
    previousState: first.state,
    targets: [target(0, 'wd1')],
    providerResults: [result(target(0, 'wd1'))],
    rateObservations: { providers: [] },
    policy,
    finishedAt: new Date('2026-10-03T00:00:00Z'),
  });
  assert.deepEqual(moved.state.tenants.map((item) => item.healthPartition), ['workday:wd1']);
  assert.equal(moved.state.tenants[0].firstSeenAtUtc, '2026-10-02T00:00:00.000Z');
  assert.equal(tenantStateKey('workday', 'x', 'wd1'), 'workday:wd1::x');
});
