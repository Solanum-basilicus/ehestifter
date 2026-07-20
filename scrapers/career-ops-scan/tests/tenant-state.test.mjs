import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseDiscoveryPolicy } from '../src/policy/discovery-policy.mjs';
import {
  buildNextTenantState,
  createEmptyTenantState,
  isDurableTenantFailure,
  loadTenantState,
  saveTenantState,
  tenantStateMaps,
  validateTenantStateEnvelope,
} from '../src/state/tenant-state.mjs';

const NOW = new Date('2026-07-20T12:00:00.000Z');

function policy(overrides = {}) {
  return parseDiscoveryPolicy({
    schema_version: 1,
    defaults: {
      scheduling: {
        priority_interval_hours: 24,
        active_interval_hours: 24,
        healthy_interval_hours: 72,
        recent_activity_window_hours: 168,
        long_empty_after_empty_scans: 3,
        long_empty_interval_hours: 168,
        first_durable_failure_retry_hours: 24,
        suspected_dead_after_failures: 2,
        confirmed_dead_after_failures: 4,
        dead_reprobe_interval_hours: 720,
        transient_failure_cooldown_minutes: 360,
        rate_limit_cooldown_minutes: 1440,
      },
      ...overrides,
    },
    providers: { ashby: {} },
  });
}

function target({ sequence = 0, tenant = 'example', targetClass = 'normal' } = {}) {
  return { sequence, provider: 'ashby', tenant, targetClass };
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
    candidatesRetained: 0,
    durationMs: 100,
    ...overrides,
  };
}

function observations(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAtUtc: NOW.toISOString(),
    providers: [{
      provider: 'ashby',
      requestsAttempted: 1,
      rateLimited: 0,
      ...overrides,
    }],
  };
}

function transition({ previousState = createEmptyTenantState(NOW), targetValue = target(), resultValue = result(), breakerEvents = [], rate = observations(), at = NOW } = {}) {
  return buildNextTenantState({
    previousState,
    targets: [targetValue],
    providerResults: [resultValue],
    rateObservations: rate,
    breakerEvents,
    policy: policy(),
    finishedAt: at,
  });
}

test('missing state file starts with an empty scanner-owned state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tenant-state-'));
  try {
    const state = await loadTenantState(path.join(directory, 'missing.json'), { now: NOW });
    assert.deepEqual(state, createEmptyTenantState(NOW));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('state save is atomic and round-trips validated data', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tenant-state-'));
  try {
    const file = path.join(directory, 'nested', 'state.json');
    const state = transition().state;
    await saveTenantState(file, state);
    assert.deepEqual(await loadTenantState(file), state);
    assert.equal((await readFile(file, 'utf8')).endsWith('\n'), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid JSON and duplicate tenants fail loudly', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tenant-state-'));
  try {
    const file = path.join(directory, 'state.json');
    await writeFile(file, 'not json');
    await assert.rejects(() => loadTenantState(file), /not valid JSON/);
    const state = transition().state;
    state.tenants.push({ ...state.tenants[0] });
    assert.throws(() => validateTenantStateEnvelope(state), /Duplicate tenant state/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('successful relevant scan marks a normal tenant active for 24 hours', () => {
  const next = transition({ resultValue: result({ candidatesRetained: 2 }) });
  const tenant = next.state.tenants[0];
  assert.equal(tenant.health, 'active');
  assert.equal(tenant.lastRelevantCandidateAtUtc, NOW.toISOString());
  assert.equal(tenant.nextEligibleScanAtUtc, '2026-07-21T12:00:00.000Z');
});

test('priority success remains daily even without relevant candidates', () => {
  const next = transition({
    targetValue: target({ targetClass: 'priority' }),
    resultValue: result({ targetClass: 'priority', candidatesRetained: 0 }),
  });
  assert.equal(next.state.tenants[0].nextEligibleScanAtUtc, '2026-07-21T12:00:00.000Z');
});

test('healthy normal success is scheduled on the 72-hour rotation', () => {
  const next = transition();
  assert.equal(next.state.tenants[0].health, 'healthy');
  assert.equal(next.state.tenants[0].nextEligibleScanAtUtc, '2026-07-23T12:00:00.000Z');
});

test('recently active tenant stays active after a no-match success', () => {
  const first = transition({ resultValue: result({ candidatesRetained: 1 }) }).state;
  const second = transition({
    previousState: first,
    resultValue: result({ candidatesRetained: 0 }),
    at: new Date('2026-07-21T12:00:00.000Z'),
  });
  assert.equal(second.state.tenants[0].health, 'active');
});

test('three empty successes demote a normal tenant to weekly long-empty cadence', () => {
  let state = createEmptyTenantState(NOW);
  for (let index = 0; index < 3; index += 1) {
    state = transition({
      previousState: state,
      resultValue: result({ jobsReturned: 0 }),
      at: new Date(NOW.getTime() + index * 3_600_000),
    }).state;
  }
  const tenant = state.tenants[0];
  assert.equal(tenant.health, 'long_empty');
  assert.equal(tenant.consecutiveEmptySuccesses, 3);
  assert.equal(tenant.nextEligibleScanAtUtc, '2026-07-27T14:00:00.000Z');
});

test('a non-empty success resets the empty streak', () => {
  let state = transition({ resultValue: result({ jobsReturned: 0 }) }).state;
  state = transition({ previousState: state, resultValue: result({ jobsReturned: 5 }) }).state;
  assert.equal(state.tenants[0].consecutiveEmptySuccesses, 0);
  assert.equal(state.tenants[0].health, 'healthy');
});

test('first 404 is retried after one day, second becomes suspected dead', () => {
  const failed = result({
    status: 'error', errorClass: 'http_4xx', httpStatus: 404, jobsReturned: 0,
  });
  const first = transition({ resultValue: failed });
  assert.equal(first.state.tenants[0].health, 'temporarily_failed');
  assert.equal(first.state.tenants[0].nextEligibleScanAtUtc, '2026-07-21T12:00:00.000Z');
  const second = transition({
    previousState: first.state,
    resultValue: failed,
    at: new Date('2026-07-21T12:00:00.000Z'),
  });
  assert.equal(second.state.tenants[0].health, 'suspected_dead');
  assert.equal(second.state.tenants[0].nextEligibleScanAtUtc, '2026-08-20T12:00:00.000Z');
});

test('fourth repeated durable failure becomes confirmed dead', () => {
  const failed = result({
    status: 'error', errorClass: 'http_4xx', httpStatus: 410, jobsReturned: 0,
  });
  let state = createEmptyTenantState(NOW);
  for (let index = 0; index < 4; index += 1) {
    state = transition({
      previousState: state,
      resultValue: failed,
      at: new Date(NOW.getTime() + index * 3_600_000),
    }).state;
  }
  assert.equal(state.tenants[0].health, 'confirmed_dead');
  assert.equal(state.tenants[0].consecutiveDurableFailures, 4);
});

test('success revives a suspected-dead tenant and resets failures', () => {
  const failed = result({ status: 'error', errorClass: 'http_4xx', httpStatus: 404 });
  let state = transition({ resultValue: failed }).state;
  state = transition({ previousState: state, resultValue: failed }).state;
  state = transition({ previousState: state, resultValue: result() }).state;
  const tenant = state.tenants[0];
  assert.equal(tenant.health, 'healthy');
  assert.equal(tenant.consecutiveFailures, 0);
  assert.equal(tenant.consecutiveDurableFailures, 0);
});

test('rate limit sets tenant cooldown for 24 hours', () => {
  const next = transition({
    resultValue: result({ status: 'error', errorClass: 'rate_limited', httpStatus: 429 }),
  });
  assert.equal(next.state.tenants[0].health, 'cooldown');
  assert.equal(next.state.tenants[0].cooldownUntilUtc, '2026-07-21T12:00:00.000Z');
});

test('network failure uses transient six-hour retry and resets durable streak', () => {
  const durable = result({ status: 'error', errorClass: 'http_4xx', httpStatus: 404 });
  const first = transition({ resultValue: durable }).state;
  const next = transition({
    previousState: first,
    resultValue: result({ status: 'error', errorClass: 'network' }),
  });
  const tenant = next.state.tenants[0];
  assert.equal(tenant.health, 'temporarily_failed');
  assert.equal(tenant.consecutiveDurableFailures, 0);
  assert.equal(tenant.consecutiveTransientFailures, 1);
  assert.equal(tenant.nextEligibleScanAtUtc, '2026-07-20T18:00:00.000Z');
});

test('skipped-by-circuit result does not mutate tenant attempt state', () => {
  const skipped = result({ status: 'skipped', skipReason: 'provider_circuit_open' });
  const next = transition({ resultValue: skipped });
  assert.equal(next.state.tenants.length, 0);
  assert.equal(next.changes.tenantChanges.length, 0);
});

test('breaker activation persists provider cooldown independently of tenant health', () => {
  const next = transition({
    breakerEvents: [{ provider: 'ashby', reason: 'rate_limit_threshold' }],
  });
  const provider = next.state.providers[0];
  assert.equal(provider.health, 'cooldown');
  assert.equal(provider.cooldownUntilUtc, '2026-07-21T12:00:00.000Z');
  assert.equal(provider.lastBreakerReason, 'rate_limit_threshold');
});

test('expired provider cooldown clears without fabricating a provider run', () => {
  const previousState = createEmptyTenantState(new Date('2026-07-19T00:00:00.000Z'));
  previousState.providers.push({
    provider: 'ashby',
    health: 'cooldown',
    cooldownUntilUtc: '2026-07-20T11:00:00.000Z',
    lastBreakerAtUtc: '2026-07-19T11:00:00.000Z',
    lastBreakerReason: 'rate_limit_threshold',
    lastRunAtUtc: '2026-07-19T11:00:00.000Z',
    lastRequestsAttempted: 10,
    lastRateLimited: 2,
  });
  const next = buildNextTenantState({
    previousState,
    targets: [],
    providerResults: [],
    rateObservations: { providers: [] },
    breakerEvents: [],
    policy: policy(),
    finishedAt: NOW,
  }).state.providers[0];
  assert.equal(next.health, 'healthy');
  assert.equal(next.cooldownUntilUtc, null);
  assert.equal(next.lastRunAtUtc, '2026-07-19T11:00:00.000Z');
  assert.equal(next.lastRequestsAttempted, 10);
});

test('tenant and provider changes are compact audit artifacts', () => {
  const next = transition({ resultValue: result({ candidatesRetained: 1 }) });
  assert.deepEqual(Object.keys(next.changes).sort(), [
    'generatedAtUtc', 'providerChanges', 'schemaVersion', 'tenantChanges',
  ]);
  assert.equal(next.changes.tenantChanges[0].health, 'active');
});

test('durable classification requires exact 404 or 410 status', () => {
  assert.equal(isDurableTenantFailure({ errorClass: 'http_4xx', httpStatus: 404 }), true);
  assert.equal(isDurableTenantFailure({ errorClass: 'http_4xx', httpStatus: 410 }), true);
  assert.equal(isDurableTenantFailure({ errorClass: 'http_4xx', httpStatus: 403 }), false);
  assert.equal(isDurableTenantFailure({ errorClass: 'provider_error', httpStatus: 404 }), false);
});

test('state maps use case-insensitive provider and tenant identity', () => {
  const state = transition().state;
  const maps = tenantStateMaps(state);
  assert.equal(maps.tenants.get('ashby::example').tenant, 'example');
});
