import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTargetPlan } from '../src/targets/planner.mjs';

function policy() {
  return {
    schema_version: 1,
    providers: { ashby: { catalog_enabled: false } },
  };
}

function state() {
  return {
    schemaVersion: 1,
    updatedAtUtc: '2026-07-22T00:00:00.000Z',
    tenants: [],
    providers: [],
  };
}

function provider(id, tenant) {
  return {
    id,
    fetch() {},
    detect(entry) { return entry.provider === id ? { url: entry.careers_url } : null; },
    tenant,
    sourceOrigin() { return `https://source.${id}.example`; },
  };
}

test('planner delegates new provider tenant identity to provider contract', () => {
  const providers = new Map([
    ['personio', provider('personio', () => 'personio-company')],
    ['smartrecruiters', provider('smartrecruiters', () => 'ExactTenant')],
    ['softgarden', provider('softgarden', () => 'softgarden-company')],
    ['successfactors', provider('successfactors', () => 'jobs.example.com/Brand')],
  ]);
  const entries = [...providers.keys()].map((id) => ({
    name: id,
    provider: id,
    careers_url: `https://${id}.example.com/jobs`,
    enabled: true,
  }));
  const result = buildTargetPlan({
    portalConfig: { tracked_companies: entries },
    companyOverrides: { schema_version: 1, priority: { ashby: [] }, disabled: { ashby: [] } },
    discoveryPolicy: policy(),
    tenantState: state(),
    providers,
    mode: 'preflight',
    generatedAt: new Date('2026-07-22T00:00:00Z'),
  });
  assert.deepEqual(
    result.runtimeTargets.map((target) => target.tenant),
    ['personio-company', 'ExactTenant', 'softgarden-company', 'jobs.example.com/Brand'],
  );
  assert.equal(
    result.runtimeTargets[3].sourceOrigin,
    'https://source.successfactors.example',
  );
});

test('provider tenant failure becomes a planning rejection, not a malformed target', () => {
  const providers = new Map([
    ['personio', provider('personio', () => null)],
  ]);
  const result = buildTargetPlan({
    portalConfig: {
      tracked_companies: [{
        name: 'Broken',
        provider: 'personio',
        careers_url: 'https://broken.example.com',
      }],
    },
    companyOverrides: { schema_version: 1, priority: { ashby: [] }, disabled: { ashby: [] } },
    discoveryPolicy: policy(),
    tenantState: state(),
    providers,
    mode: 'preflight',
    generatedAt: new Date('2026-07-22T00:00:00Z'),
  });
  assert.equal(result.runtimeTargets.length, 0);
  assert.equal(result.planningRejections.length, 1);
  assert.match(result.planningRejections[0].details.error, /could not derive a tenant/);
});

test('planner annotates SuccessFactors RMK and CSB health partitions independently', () => {
  const providers = new Map([
    ['successfactors', provider('successfactors', (entry) => new URL(entry.careers_url).hostname)],
  ]);
  const result = buildTargetPlan({
    portalConfig: {
      tracked_companies: [
        {
          name: 'EY',
          provider: 'successfactors',
          sf_variant: 'rmk',
          careers_url: 'https://careers.ey.com/ey/search/',
        },
        {
          name: 'Gore',
          provider: 'successfactors',
          sf_variant: 'csb',
          careers_url: 'https://wlgore.jobs.hr.cloud.sap/',
        },
      ],
    },
    companyOverrides: { schema_version: 1, priority: { ashby: [] }, disabled: { ashby: [] } },
    discoveryPolicy: policy(),
    tenantState: state(),
    providers,
    mode: 'preflight',
    generatedAt: new Date('2026-07-22T00:00:00Z'),
  });
  assert.deepEqual(
    result.runtimeTargets.map((target) => [target.providerVariant, target.healthPartition]),
    [
      ['rmk', 'successfactors:rmk'],
      ['csb', 'successfactors:csb'],
    ],
  );
  assert.deepEqual(
    result.plan.targets.map((target) => target.healthPartition),
    ['successfactors:rmk', 'successfactors:csb'],
  );
  assert.equal(result.plan.healthPartitions['successfactors:rmk'].selectedTargets, 1);
  assert.equal(result.plan.healthPartitions['successfactors:csb'].selectedTargets, 1);
});

test('provider canaries are planned as priority health-only targets', () => {
  const providers = new Map([
    ['successfactors', provider('successfactors', (entry) => new URL(entry.careers_url).hostname)],
  ]);
  const result = buildTargetPlan({
    portalConfig: {
      provider_canaries: [{
        name: 'Gore CSB canary',
        provider: 'successfactors',
        sf_variant: 'csb',
        careers_url: 'https://wlgore.jobs.hr.cloud.sap/',
        minimum_jobs: 5,
        detail_sample_size: 2,
        minimum_detail_successes: 1,
        interval_hours: 24,
      }],
    },
    companyOverrides: { schema_version: 1, priority: { ashby: [] }, disabled: { ashby: [] } },
    discoveryPolicy: policy(),
    tenantState: state(),
    providers,
    mode: 'preflight',
    generatedAt: new Date('2026-07-22T00:00:00Z'),
  });
  assert.equal(result.plan.counts.priority, 1);
  assert.equal(result.plan.counts.canary, 1);
  assert.equal(result.runtimeTargets[0].healthOnly, true);
  assert.equal(result.runtimeTargets[0].reason, 'provider_canary');
  assert.deepEqual(result.runtimeTargets[0].canary, {
    minimumJobs: 5,
    detailSampleSize: 2,
    minimumDetailSuccesses: 1,
    intervalHours: 24,
  });
});

test('tracked target and duplicate provider canary share one fetch', () => {
  const providers = new Map([
    ['successfactors', provider('successfactors', (entry) => new URL(entry.careers_url).hostname)],
  ]);
  const shared = {
    provider: 'successfactors',
    sf_variant: 'csb',
    careers_url: 'https://wlgore.jobs.hr.cloud.sap/',
  };
  const result = buildTargetPlan({
    portalConfig: {
      tracked_companies: [{ name: 'Gore', ...shared }],
      provider_canaries: [{ name: 'Gore canary', ...shared }],
    },
    companyOverrides: { schema_version: 1, priority: { ashby: [] }, disabled: { ashby: [] } },
    discoveryPolicy: policy(),
    tenantState: state(),
    providers,
    mode: 'preflight',
    generatedAt: new Date('2026-07-22T00:00:00Z'),
  });
  assert.equal(result.runtimeTargets.length, 1);
  assert.equal(result.runtimeTargets[0].healthOnly, false);
  assert.equal(result.runtimeTargets[0].canaryAttached, true);
  assert.equal(result.runtimeTargets[0].canary.minimumJobs, 1);
  assert.equal(result.plan.counts.canary, 1);
  assert.equal(result.plan.counts.deduplicated, 1);
  assert.equal(result.planningRejections.length, 0);
});


test('provider canary minimum_jobs must remain positive', () => {
  const providers = new Map([
    ['successfactors', provider('successfactors', (entry) => new URL(entry.careers_url).hostname)],
  ]);
  const result = buildTargetPlan({
    portalConfig: {
      provider_canaries: [{
        name: 'Invalid zero canary',
        provider: 'successfactors',
        sf_variant: 'csb',
        careers_url: 'https://wlgore.jobs.hr.cloud.sap/',
        minimum_jobs: 0,
      }],
    },
    companyOverrides: { schema_version: 1, priority: { ashby: [] }, disabled: { ashby: [] } },
    discoveryPolicy: policy(),
    tenantState: state(),
    providers,
    mode: 'preflight',
    generatedAt: new Date('2026-07-22T00:00:00Z'),
  });
  assert.equal(result.runtimeTargets.length, 0);
  assert.equal(result.planningRejections.length, 1);
  assert.equal(result.plan.counts.canaryPlanningRejected, 1);
  assert.match(result.planningRejections[0].details.error, /minimum_jobs.*1 to 100000/);
});
