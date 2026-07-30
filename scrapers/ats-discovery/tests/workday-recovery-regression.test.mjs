import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDiscoveryPolicy } from '../src/policy/discovery-policy.mjs';
import workday from '../src/providers/workday.mjs';
import {
  classifyProviderError,
  isDurableProviderResult,
} from '../src/scan/provider-errors.mjs';
import { executeProviderTargets } from '../src/scan/provider-executor.mjs';
import {
  buildNextTenantState,
  createEmptyTenantState,
} from '../src/state/tenant-state.mjs';

const NOW = new Date('2026-07-30T12:00:00.000Z');

function httpError(status, body = '') {
  const error = new Error(`HTTP ${status}`);
  error.status = status;
  error.body = body;
  return error;
}

function policy({ transientThreshold = 2 } = {}) {
  return parseDiscoveryPolicy({
    schema_version: 1,
    defaults: {
      execution: {
        concurrency: 1,
        min_request_interval_ms: 0,
        breaker: {
          rate_limit_threshold: 2,
          transient_error_threshold: transientThreshold,
          transient_error_ratio_threshold: 0.5,
          minimum_requests_for_ratio: 2,
          cooldown_minutes: 1440,
        },
      },
      scheduling: {
        first_durable_failure_retry_hours: 24,
        suspected_dead_after_failures: 2,
        confirmed_dead_after_failures: 4,
        dead_reprobe_interval_hours: 720,
      },
    },
    providers: {
      ashby: {},
      workday: {},
    },
  });
}

async function capturedWorkdayError({ status, body, scheduleBucket = 'recovery', healthOnly = false }) {
  const error = httpError(status, JSON.stringify(body));
  try {
    await workday.fetch(
      {
        name: 'probe',
        careers_url: 'https://example.wd5.myworkdayjobs.com/site',
        scheduleBucket,
        healthOnly,
      },
      {
        maxPages: 1,
        fetchJson: async () => { throw error; },
      },
    );
  } catch (caught) {
    return caught;
  }
  assert.fail('expected Workday fetch to fail');
}

test('Workday HTTP_422 is classified as a durable invalid-tenant result', async () => {
  const error = await capturedWorkdayError({
    status: 422,
    body: { errorCode: 'HTTP_422', httpStatus: 422, message: '' },
  });
  assert.equal(error.code, 'WORKDAY_TENANT_INVALID');
  const result = {
    status: 'error',
    errorClass: classifyProviderError(error),
    httpStatus: 422,
  };
  assert.equal(result.errorClass, 'workday_tenant_invalid');
  assert.equal(isDurableProviderResult(result), true);
});

test('Workday S22 permission denial is classified as a durable restricted tenant', async () => {
  const error = await capturedWorkdayError({
    status: 403,
    body: { errorCode: 'S22', httpStatus: 403, message: 'permission denied' },
  });
  assert.equal(error.code, 'WORKDAY_TENANT_RESTRICTED');
  const result = {
    status: 'error',
    errorClass: classifyProviderError(error),
    httpStatus: 403,
  };
  assert.equal(result.errorClass, 'workday_tenant_restricted');
  assert.equal(isDurableProviderResult(result), true);
});

test('recognized Workday 422 is durable for a normal healthy target', async () => {
  const error = await capturedWorkdayError({
    status: 422,
    scheduleBucket: 'healthy',
    body: { errorCode: 'HTTP_422', httpStatus: 422, message: '' },
  });
  assert.equal(error.code, 'WORKDAY_TENANT_INVALID');
  const result = {
    status: 'error',
    errorClass: classifyProviderError(error),
    httpStatus: 422,
  };
  assert.equal(result.errorClass, 'workday_tenant_invalid');
  assert.equal(isDurableProviderResult(result), true);
});

test('recognized Workday S22 is durable for a normal healthy target', async () => {
  const error = await capturedWorkdayError({
    status: 403,
    scheduleBucket: 'healthy',
    body: { errorCode: 'S22', httpStatus: 403, message: 'permission denied' },
  });
  assert.equal(error.code, 'WORKDAY_TENANT_RESTRICTED');
  assert.equal(classifyProviderError(error), 'workday_tenant_restricted');
});

test('recognized Workday 422 on a health-only canary remains provider-level', async () => {
  const error = await capturedWorkdayError({
    status: 422,
    healthOnly: true,
    body: { errorCode: 'HTTP_422', httpStatus: 422, message: '' },
  });
  assert.equal(error.code, 'WORKDAY_REQUEST_REJECTED');
  const result = {
    status: 'error',
    errorClass: classifyProviderError(error),
    httpStatus: 422,
  };
  assert.equal(result.errorClass, 'provider_schema');
  assert.equal(isDurableProviderResult(result), false);
});

test('recognized Workday S22 on a health-only canary remains provider-level', async () => {
  const error = await capturedWorkdayError({
    status: 403,
    healthOnly: true,
    body: { errorCode: 'S22', httpStatus: 403, message: 'permission denied' },
  });
  assert.equal(error.code, undefined);
  assert.equal(classifyProviderError(error), 'http_4xx');
});

test('unknown Workday 403 remains a generic transient 4xx', async () => {
  const error = await capturedWorkdayError({
    status: 403,
    body: { errorCode: 'OTHER', httpStatus: 403, message: 'blocked' },
  });
  assert.equal(error.code, undefined);
  assert.equal(classifyProviderError(error), 'http_4xx');
});

test('maintenance tenant-local 4xx failures do not open the provider circuit', async () => {
  let calls = 0;
  const targets = [
    ...Array.from({ length: 5 }, (_, sequence) => ({
      sequence,
      provider: 'workday',
      tenant: `recovery-${sequence}`,
      targetClass: 'normal',
      scheduleBucket: 'recovery',
    })),
    {
      sequence: 5,
      provider: 'workday',
      tenant: 'healthy-control',
      targetClass: 'normal',
      scheduleBucket: 'healthy',
    },
  ];
  const result = await executeProviderTargets({
    targets,
    policy: policy(),
    globalConcurrency: 1,
    fetchTarget: async (target) => {
      calls += 1;
      if (target.scheduleBucket === 'recovery') throw httpError(403);
      return [];
    },
  });
  assert.equal(calls, 6);
  assert.equal(result.breakerEvents.length, 0);
  assert.equal(result.batches.at(-1).providerResult.status, 'ok');
});

test('maintenance rate limits still open the provider circuit', async () => {
  let calls = 0;
  const result = await executeProviderTargets({
    targets: [0, 1, 2].map((sequence) => ({
      sequence,
      provider: 'workday',
      tenant: `recovery-${sequence}`,
      targetClass: 'normal',
      scheduleBucket: 'recovery',
    })),
    policy: policy(),
    globalConcurrency: 1,
    fetchTarget: async () => {
      calls += 1;
      throw httpError(429);
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.breakerEvents[0].reason, 'rate_limit_threshold');
  assert.equal(result.batches[2].providerResult.status, 'skipped');
});

test('maintenance provider-level failures still open the provider circuit', async () => {
  let calls = 0;
  const result = await executeProviderTargets({
    targets: [0, 1, 2].map((sequence) => ({
      sequence,
      provider: 'workday',
      tenant: `recovery-${sequence}`,
      targetClass: 'normal',
      scheduleBucket: 'recovery',
    })),
    policy: policy({ transientThreshold: 2 }),
    globalConcurrency: 1,
    fetchTarget: async () => {
      calls += 1;
      throw httpError(500);
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.breakerEvents[0].reason, 'transient_error_threshold');
  assert.equal(result.batches[2].providerResult.status, 'skipped');
});

test('repeated classified Workday failures progress through durable tenant state', () => {
  const target = {
    sequence: 0,
    provider: 'workday',
    tenant: 'invalid-site',
    targetClass: 'normal',
    scheduleBucket: 'recovery',
  };
  const providerResult = {
    sequence: 0,
    provider: 'workday',
    tenant: 'invalid-site',
    targetClass: 'normal',
    status: 'error',
    skipReason: null,
    errorClass: 'workday_tenant_invalid',
    errorMessage: 'HTTP 422',
    httpStatus: 422,
    jobsReturned: 0,
    candidatesMatched: 0,
    candidatesRetained: 0,
    durationMs: 1,
    listingOutcome: 'listing_error',
  };
  const first = buildNextTenantState({
    previousState: createEmptyTenantState(NOW),
    targets: [target],
    providerResults: [providerResult],
    rateObservations: { providers: [] },
    policy: policy(),
    finishedAt: NOW,
  });
  assert.equal(first.state.tenants[0].health, 'temporarily_failed');
  assert.equal(first.state.tenants[0].consecutiveDurableFailures, 1);

  const second = buildNextTenantState({
    previousState: first.state,
    targets: [target],
    providerResults: [providerResult],
    rateObservations: { providers: [] },
    policy: policy(),
    finishedAt: new Date('2026-07-31T12:00:00.000Z'),
  });
  assert.equal(second.state.tenants[0].health, 'suspected_dead');
  assert.equal(second.state.tenants[0].consecutiveDurableFailures, 2);
});
