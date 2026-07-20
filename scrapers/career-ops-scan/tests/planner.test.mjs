import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseDiscoveryPolicy } from '../src/policy/discovery-policy.mjs';
import { createEmptyTenantState } from '../src/state/tenant-state.mjs';
import {
  buildTargetPlan,
  buildTargetPlanFromFiles,
  PHASE3_MAX_NORMAL_TARGETS_PER_RUN,
} from '../src/targets/planner.mjs';
import ashbyProvider from '../src/providers/ashby.mjs';
import greenhouseProvider from '../src/providers/greenhouse.mjs';
import leverProvider from '../src/providers/lever.mjs';
import workdayProvider from '../src/providers/workday.mjs';

const NOW = new Date('2026-07-20T12:00:00.000Z');

function providers() {
  return new Map([
    [greenhouseProvider.id, greenhouseProvider],
    [leverProvider.id, leverProvider],
    [ashbyProvider.id, ashbyProvider],
    [workdayProvider.id, workdayProvider],
  ]);
}

function portalConfig() {
  return {
    tracked_companies: [
      { name: 'Celonis', careers_url: 'https://job-boards.greenhouse.io/celonis', enabled: true },
      { name: 'Rainfocus', careers_url: 'https://jobs.lever.co/rainfocus', enabled: true },
      { name: 'n8n', careers_url: 'https://jobs.ashbyhq.com/n8n', enabled: true },
    ],
  };
}

function overrides({ priority = [], disabled = [] } = {}) {
  return {
    schema_version: 1,
    priority: { ashby: priority },
    disabled: { ashby: disabled },
  };
}

function rawPolicy({ max = 3, days = 3, catalogEnabled = true } = {}) {
  return {
    schema_version: 1,
    providers: {
      ashby: {
        catalog_enabled: catalogEnabled,
        max_normal_targets_per_run: max,
        target_full_sweep_days: days,
      },
    },
  };
}

function catalog(tenants = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
  return {
    schemaVersion: 1,
    provider: 'ashby',
    fetchedAtUtc: '2026-07-20T00:00:00.000Z',
    source: {
      repository: 'Feashliaa/job-board-aggregator',
      path: 'data/ashby_companies.json',
      url: 'https://example.test/ashby.json',
      license: 'CC BY-NC 4.0',
    },
    rawSha256: 'a'.repeat(64),
    sourceItemCount: tenants.length,
    acceptedItemCount: tenants.length,
    rejectedItemCount: 0,
    duplicateItemCount: 0,
    rejections: [],
    tenants,
  };
}

function tenantState(entries = [], providersState = []) {
  return {
    schemaVersion: 1,
    updatedAtUtc: '2026-07-20T00:00:00.000Z',
    providers: providersState,
    tenants: entries.map((entry) => ({
      provider: 'ashby',
      tenant: entry.tenant,
      firstSeenAtUtc: '2026-07-01T00:00:00.000Z',
      lastAttemptAtUtc: entry.lastAttemptAtUtc ?? '2026-07-19T00:00:00.000Z',
      lastSuccessfulAtUtc: entry.lastSuccessfulAtUtc ?? '2026-07-19T00:00:00.000Z',
      lastRelevantCandidateAtUtc: entry.lastRelevantCandidateAtUtc ?? null,
      lastJobsReturned: 1,
      lastCandidatesRetained: 0,
      lastDurationMs: 100,
      consecutiveFailures: entry.consecutiveFailures ?? 0,
      consecutiveDurableFailures: entry.consecutiveDurableFailures ?? 0,
      consecutiveTransientFailures: entry.consecutiveTransientFailures ?? 0,
      consecutiveEmptySuccesses: entry.consecutiveEmptySuccesses ?? 0,
      health: entry.health ?? 'healthy',
      cooldownUntilUtc: entry.cooldownUntilUtc ?? null,
      nextEligibleScanAtUtc: entry.nextEligibleScanAtUtc ?? null,
      lastErrorClass: entry.lastErrorClass ?? null,
      lastHttpStatus: entry.lastHttpStatus ?? null,
    })),
  };
}

function build(options = {}) {
  const raw = options.discoveryPolicy ?? rawPolicy();
  return buildTargetPlan({
    portalConfig: options.portalConfig ?? portalConfig(),
    companyOverrides: options.companyOverrides ?? overrides(),
    discoveryPolicy: raw.schemaVersion === 1 ? raw : parseDiscoveryPolicy(raw),
    ashbyCatalog: options.ashbyCatalog === undefined ? catalog() : options.ashbyCatalog,
    tenantState: options.tenantState ?? createEmptyTenantState(NOW),
    providers: options.providers ?? providers(),
    mode: options.mode ?? 'offline',
    generatedAt: options.generatedAt ?? NOW,
  });
}

test('priority targets remain first and tracked order is preserved', () => {
  const result = build();
  assert.deepEqual(
    result.plan.targets.slice(0, 3).map((item) => item.tenant),
    ['celonis', 'rainfocus', 'n8n'],
  );
  assert.equal(result.plan.targets.slice(0, 3).every((item) => item.targetClass === 'priority'), true);
});

test('explicit priority is appended and disabled still wins', () => {
  const result = build({
    companyOverrides: overrides({ priority: ['extra', 'n8n'], disabled: ['extra'] }),
  });
  assert.equal(result.plan.targets.some((item) => item.tenant === 'extra'), false);
  assert.equal(result.plan.counts.disabledRemoved, 1);
  assert.equal(result.plan.counts.deduplicated >= 1, true);
});

test('offline planner selects only due priority tenants', () => {
  const state = tenantState([{ tenant: 'n8n', nextEligibleScanAtUtc: '2026-07-21T12:00:00.000Z' }]);
  const result = build({ tenantState: state });
  assert.equal(result.plan.targets.some((item) => item.tenant === 'n8n'), false);
  assert.equal(result.plan.counts.skippedNotDue, 1);
});

test('preflight and import bypass cadence but remain priority-only', () => {
  const state = tenantState([{ tenant: 'n8n', nextEligibleScanAtUtc: '2026-08-01T00:00:00.000Z' }]);
  for (const mode of ['preflight', 'import']) {
    const result = build({ mode, tenantState: state, ashbyCatalog: null });
    assert.equal(result.plan.targets.length, 3);
    assert.equal(result.plan.targets.every((item) => item.targetClass === 'priority'), true);
    assert.equal(result.plan.targets.every((item) => item.lookbackStartUtc === null), true);
    assert.equal(result.plan.targets.every((item) => item.lookbackUnbounded === false), true);
  }
});

test('active, recovery, dead, long-empty, and healthy buckets are ordered', () => {
  const state = tenantState([
    { tenant: 'alpha', health: 'healthy' },
    { tenant: 'beta', health: 'long_empty' },
    { tenant: 'gamma', health: 'suspected_dead' },
    { tenant: 'delta', health: 'temporarily_failed' },
    { tenant: 'epsilon', health: 'active', lastRelevantCandidateAtUtc: '2026-07-20T00:00:00.000Z' },
  ]);
  const result = build({ tenantState: state, discoveryPolicy: rawPolicy({ max: 5 }) });
  const normal = result.plan.targets.filter((item) => item.targetClass === 'normal');
  assert.deepEqual(normal.map((item) => item.scheduleBucket), [
    'recent_activity', 'recovery', 'dead_reprobe', 'long_empty', 'healthy',
  ]);
});

test('selected normal targets rotate because recently scanned tenants become not due', () => {
  const first = build({ discoveryPolicy: rawPolicy({ max: 2 }) });
  const firstTenants = first.plan.targets.filter((item) => item.targetClass === 'normal').map((item) => item.tenant);
  const state = tenantState(firstTenants.map((tenant) => ({
    tenant,
    nextEligibleScanAtUtc: '2026-07-23T12:00:00.000Z',
  })));
  const second = build({ discoveryPolicy: rawPolicy({ max: 2 }), tenantState: state });
  const secondTenants = second.plan.targets.filter((item) => item.targetClass === 'normal').map((item) => item.tenant);
  assert.equal(secondTenants.some((tenant) => firstTenants.includes(tenant)), false);
});

test('normal selection is deterministic for identical state and time', () => {
  const left = build({ discoveryPolicy: rawPolicy({ max: 5 }) });
  const right = build({ discoveryPolicy: rawPolicy({ max: 5 }) });
  assert.deepEqual(left.plan.targets, right.plan.targets);
});

test('configured budget caps due normal targets and records skipped budget', () => {
  const result = build({ discoveryPolicy: rawPolicy({ max: 2 }) });
  assert.equal(result.plan.counts.normal, 2);
  assert.equal(result.plan.counts.skippedNormalBudget, 3);
});

test('sweep diagnostics show when the configured budget cannot meet three days', () => {
  const result = build({
    discoveryPolicy: rawPolicy({ max: 2, days: 3 }),
    ashbyCatalog: catalog(Array.from({ length: 10 }, (_, index) => `tenant-${index}`)),
  });
  assert.deepEqual(result.plan.sweep, {
    targetFullSweepDays: 3,
    healthyRotationTenants: 10,
    promotedDailyTenants: 0,
    exceptionalDueTenants: 0,
    configuredNormalTargetsPerRun: 2,
    recommendedHealthyTargetsPerRun: 4,
    recommendedNormalTargetsPerRun: 4,
    estimatedHealthySweepDays: 5,
    feasibleAtConfiguredBudget: false,
  });
});

test('provider cooldown suppresses all offline targets for that provider only', () => {
  const state = tenantState([], [{
    provider: 'ashby',
    health: 'cooldown',
    cooldownUntilUtc: '2026-07-21T12:00:00.000Z',
    lastBreakerAtUtc: '2026-07-20T00:00:00.000Z',
    lastBreakerReason: 'rate_limit_threshold',
    lastRunAtUtc: '2026-07-20T00:00:00.000Z',
    lastRequestsAttempted: 10,
    lastRateLimited: 2,
  }]);
  const result = build({ tenantState: state });
  assert.equal(result.plan.targets.some((item) => item.provider === 'ashby'), false);
  assert.equal(result.plan.targets.some((item) => item.provider === 'greenhouse'), true);
  assert.ok(result.plan.counts.skippedProviderCooldown > 0);
});

test('expired provider cooldown does not block planning', () => {
  const state = tenantState([], [{
    provider: 'ashby',
    health: 'cooldown',
    cooldownUntilUtc: '2026-07-20T11:00:00.000Z',
    lastBreakerAtUtc: '2026-07-19T00:00:00.000Z',
    lastBreakerReason: 'rate_limit_threshold',
    lastRunAtUtc: '2026-07-19T00:00:00.000Z',
    lastRequestsAttempted: 10,
    lastRateLimited: 2,
  }]);
  assert.equal(build({ tenantState: state }).plan.targets.some((item) => item.provider === 'ashby'), true);
});

test('lookback starts at initial window for unscanned tenants', () => {
  const result = build({ discoveryPolicy: rawPolicy({ max: 1 }) });
  const normal = result.plan.targets.find((item) => item.targetClass === 'normal');
  assert.equal(normal.lookbackStartUtc, '2026-07-17T12:00:00.000Z');
  assert.equal(normal.lookbackUnbounded, false);
});

test('lookback uses last success minus overlap but respects maximum bound', () => {
  const recent = tenantState([{ tenant: 'alpha', lastSuccessfulAtUtc: '2026-07-20T00:00:00.000Z' }]);
  const result = build({ tenantState: recent, discoveryPolicy: rawPolicy({ max: 5 }) });
  const alpha = result.plan.targets.find((item) => item.tenant === 'alpha');
  assert.equal(alpha.lookbackStartUtc, '2026-07-19T12:00:00.000Z');

  const old = tenantState([{ tenant: 'alpha', lastSuccessfulAtUtc: '2026-01-01T00:00:00.000Z' }]);
  const bounded = build({ tenantState: old, discoveryPolicy: rawPolicy({ max: 5 }) });
  assert.equal(
    bounded.plan.targets.find((item) => item.tenant === 'alpha').lookbackStartUtc,
    '2026-07-10T12:00:00.000Z',
  );
});

test('dead reprobe can use unbounded provider listing', () => {
  const state = tenantState([{ tenant: 'alpha', health: 'confirmed_dead' }]);
  const result = build({ tenantState: state, discoveryPolicy: rawPolicy({ max: 5 }) });
  const alpha = result.plan.targets.find((item) => item.tenant === 'alpha');
  assert.equal(alpha.lookbackStartUtc, null);
  assert.equal(alpha.lookbackUnbounded, true);
});

test('missing catalog fails only catalog-enabled offline planning', () => {
  assert.throws(() => build({ ashbyCatalog: null }), /catalog sync ashby/);
  assert.doesNotThrow(() => build({ mode: 'preflight', ashbyCatalog: null }));
  assert.doesNotThrow(() => build({
    ashbyCatalog: null,
    discoveryPolicy: rawPolicy({ catalogEnabled: false }),
  }));
});

test('invalid operator tenant fails clearly', () => {
  assert.throws(
    () => build({ companyOverrides: overrides({ disabled: ['bad/name'] }) }),
    /disabled.ashby\[0\] is invalid/,
  );
});

test('runtime provider objects and state objects do not leak into plan artifact', () => {
  const result = build();
  assert.equal(result.runtimeTargets[0]._provider.id, 'greenhouse');
  assert.equal('_provider' in result.plan.targets[0], false);
  assert.equal('state' in result.plan.targets[0], false);
});

test('skipped samples are bounded while counts remain complete', () => {
  const tenants = Array.from({ length: 100 }, (_, index) => `tenant-${index}`);
  const state = tenantState(tenants.map((tenant) => ({
    tenant,
    nextEligibleScanAtUtc: '2026-07-21T00:00:00.000Z',
  })));
  const result = build({ ashbyCatalog: catalog(tenants), tenantState: state });
  assert.equal(result.plan.counts.skippedNotDue, 100);
  assert.equal(result.plan.skippedSamples.length, 50);
});

test('Phase 3 hard limit is exposed and enforced by policy parser', () => {
  assert.equal(PHASE3_MAX_NORMAL_TARGETS_PER_RUN, 2000);
});

test('file-backed planner loads state and avoids catalog read in preflight', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'phase3-planner-'));
  try {
    const files = {
      portalsPath: path.join(directory, 'portals.yml'),
      companyOverridesPath: path.join(directory, 'overrides.yml'),
      discoveryPolicyPath: path.join(directory, 'policy.yml'),
      ashbyCatalogPath: path.join(directory, 'missing-catalog.json'),
      tenantStatePath: path.join(directory, 'missing-state.json'),
    };
    await writeFile(files.portalsPath, JSON.stringify(portalConfig()));
    await writeFile(files.companyOverridesPath, JSON.stringify(overrides()));
    await writeFile(files.discoveryPolicyPath, JSON.stringify(rawPolicy()));
    const result = await buildTargetPlanFromFiles({
      ...files,
      providers: providers(),
      mode: 'preflight',
      generatedAt: NOW,
    });
    assert.equal(result.plan.targets.length, 3);
    assert.equal(result.tenantState.tenants.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
