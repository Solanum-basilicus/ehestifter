import test from 'node:test';
import assert from 'node:assert/strict';

import { buildProviderCatalogEnvelope } from '../src/catalogs/provider-catalog.mjs';
import { parseDiscoveryPolicy } from '../src/policy/discovery-policy.mjs';
import { createEmptyTenantState } from '../src/state/tenant-state.mjs';
import { buildTargetPlan } from '../src/targets/planner.mjs';
import ashby from '../src/providers/ashby.mjs';
import greenhouse from '../src/providers/greenhouse.mjs';
import lever from '../src/providers/lever.mjs';
import workday from '../src/providers/workday.mjs';

const NOW = new Date('2026-07-24T12:00:00.000Z');

function catalog(provider, values) {
  return buildProviderCatalogEnvelope(provider, Buffer.from(JSON.stringify(values)), {
    fetchedAt: new Date('2026-07-24T00:00:00.000Z'),
  });
}

function allCatalogs() {
  return {
    ashby: catalog('ashby', ['ash-a', 'ash-b', 'ash-c']),
    greenhouse: catalog('greenhouse', ['gh-a', 'gh-b', 'gh-c']),
    lever: catalog('lever', ['lv-a', 'lv-b', 'lv-c']),
    workday: catalog('workday', ['wdco|wd1|External', 'other|wd3|jobs', 'third|wd5|careers']),
  };
}

function policy(budgets = { ashby: 1, greenhouse: 2, lever: 2, workday: 1 }) {
  return parseDiscoveryPolicy({
    schema_version: 1,
    providers: Object.fromEntries(Object.entries(budgets).map(([provider, max]) => [provider, {
      catalog_enabled: true,
      max_normal_targets_per_run: max,
      target_full_sweep_days: 3,
    }])),
  });
}

function providers() {
  return new Map([
    ['ashby', ashby],
    ['greenhouse', greenhouse],
    ['lever', lever],
    ['workday', workday],
  ]);
}

function build(options = {}) {
  return buildTargetPlan({
    portalConfig: options.portalConfig ?? { tracked_companies: [] },
    companyOverrides: options.companyOverrides ?? {
      schema_version: 1,
      priority: {},
      disabled: {},
    },
    discoveryPolicy: options.discoveryPolicy ?? policy(),
    catalogs: options.catalogs ?? allCatalogs(),
    tenantState: options.tenantState ?? createEmptyTenantState(NOW),
    providers: options.providers ?? providers(),
    mode: options.mode ?? 'offline',
    generatedAt: NOW,
    catalogTargetLimit: options.catalogTargetLimit ?? 0,
  });
}

test('offline planner applies independent provider budgets', () => {
  const result = build();
  assert.deepEqual(result.plan.limits.normalTargetsByProvider, {
    ashby: 1,
    greenhouse: 2,
    lever: 2,
    workday: 1,
  });
  assert.equal(result.plan.counts.normal, 6);
});

test('deterministic round-robin allocation prevents large catalogs starving smaller providers', () => {
  const result = build({
    discoveryPolicy: policy({ ashby: 3, greenhouse: 3, lever: 3, workday: 3 }),
    mode: 'preflight',
    catalogTargetLimit: 5,
  });
  const normal = result.plan.targets.filter((target) => target.targetClass === 'normal');
  assert.deepEqual(normal.map((target) => target.provider), [
    'ashby', 'greenhouse', 'lever', 'workday', 'ashby',
  ]);
  assert.deepEqual(build({
    discoveryPolicy: policy({ ashby: 3, greenhouse: 3, lever: 3, workday: 3 }),
    mode: 'preflight',
    catalogTargetLimit: 5,
  }).plan.targets, result.plan.targets);
});

test('Workday catalog keeps structured host tenant and site identity', () => {
  const result = build();
  const target = result.runtimeTargets.find((item) => item.provider === 'workday');
  assert.match(target.careers_url, /^https:\/\/[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com\//);
  assert.match(target.tenant, /^[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com\//);
  assert.equal(target.workday_site.length > 0, true);
  const artifactTarget = result.plan.targets.find((item) => item.provider === 'workday');
  assert.equal(artifactTarget.catalogRef, 'workday');
});

test('priority and disabled overrides work independently for every catalog provider', () => {
  const result = build({
    companyOverrides: {
      schema_version: 1,
      priority: {
        greenhouse: ['priority-gh'],
        workday: ['priorityco|wd2|External'],
      },
      disabled: {
        greenhouse: ['priority-gh', 'gh-a'],
        lever: ['lv-a'],
      },
    },
  });
  assert.equal(result.plan.targets.some((item) => item.tenant === 'priority-gh'), false);
  assert.equal(result.plan.targets.some((item) => item.tenant === 'gh-a'), false);
  assert.equal(result.plan.targets.some((item) => item.tenant === 'lv-a'), false);
  assert.equal(
    result.plan.targets.some((item) => item.tenant === 'priorityco.wd2.myworkdayjobs.com/External'),
    true,
  );
  assert.equal(result.plan.counts.disabledRemoved, 1);
});

test('plan exposes per-catalog hashes eligibility planned counts and sweep diagnostics', () => {
  const result = build();
  for (const provider of ['ashby', 'greenhouse', 'lever', 'workday']) {
    assert.equal(result.plan.catalogs[provider].rawSha256.length, 64);
    assert.equal(result.plan.catalogs[provider].acceptedItemCount, 3);
    assert.equal(result.plan.catalogs[provider].eligibleItemCount, 3);
    assert.equal(
      result.plan.catalogs[provider].plannedTargetCount,
      result.plan.limits.normalTargetsByProvider[provider],
    );
    assert.ok(result.plan.catalogSweeps[provider]);
  }
});

test('missing enabled provider catalog fails with an actionable provider-specific command', () => {
  const catalogs = allCatalogs();
  delete catalogs.lever;
  assert.throws(
    () => build({ catalogs }),
    /Run "catalog sync lever" first/,
  );
});

test('catalog-disabled providers require neither a file nor a budget allocation', () => {
  const catalogs = allCatalogs();
  delete catalogs.workday;
  const result = build({
    catalogs,
    discoveryPolicy: parseDiscoveryPolicy({
      schema_version: 1,
      providers: {
        ashby: { catalog_enabled: true, max_normal_targets_per_run: 1 },
        greenhouse: { catalog_enabled: true, max_normal_targets_per_run: 1 },
        lever: { catalog_enabled: true, max_normal_targets_per_run: 1 },
        workday: { catalog_enabled: false, max_normal_targets_per_run: 1 },
      },
    }),
  });
  assert.equal(result.plan.catalogs.workday, null);
  assert.equal(result.plan.targets.some((item) => item.provider === 'workday'), false);
});

test('live catalog target request is an upper bound capped by combined provider budgets', () => {
  const result = build({ mode: 'preflight', catalogTargetLimit: 4 });
  assert.equal(result.plan.counts.normal, 4);
  assert.equal(result.plan.targets.filter((item) => item.targetClass === 'normal').length, 4);
  assert.equal(result.plan.limits.catalogTargetsRequested, 4);
  assert.equal(result.plan.limits.catalogTargetsEffective, 4);

  const aboveCapacity = build({ mode: 'preflight', catalogTargetLimit: 7 });
  assert.equal(aboveCapacity.plan.counts.normal, 6);
  assert.equal(aboveCapacity.plan.limits.catalogTargetsRequested, 7);
  assert.equal(aboveCapacity.plan.limits.catalogTargetsEffective, 6);
  assert.equal(aboveCapacity.plan.limits.combinedPolicyCapacity, 6);
});
test('scheduler bucket priority is global before provider round-robin fairness', () => {
  const tenantState = createEmptyTenantState(NOW);
  tenantState.tenants.push({
    provider: 'greenhouse',
    tenant: 'gh-a',
    firstSeenAtUtc: '2026-07-20T00:00:00.000Z',
    health: 'active',
    nextEligibleScanAtUtc: null,
  });
  const result = build({
    tenantState,
    discoveryPolicy: policy({ ashby: 3, greenhouse: 3, lever: 3, workday: 3 }),
    mode: 'preflight',
    catalogTargetLimit: 1,
  });
  const normal = result.plan.targets.filter((target) => target.targetClass === 'normal');
  assert.equal(normal.length, 1);
  assert.equal(normal[0].provider, 'greenhouse');
  assert.equal(normal[0].scheduleBucket, 'recent_activity');
});
