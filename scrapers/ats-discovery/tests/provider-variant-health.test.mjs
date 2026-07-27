import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDiscoveryPolicy } from '../src/policy/discovery-policy.mjs';
import {
  providerHealthPartition,
  successFactorsVariant,
  targetHealthIdentity,
} from '../src/providers/_variant.mjs';
import { buildRunSummary } from '../src/run-summary.mjs';
import { buildProviderCanaryResults } from '../src/scan/provider-canaries.mjs';
import { executeProviderTargets } from '../src/scan/provider-executor.mjs';
import { buildRateObservations } from '../src/scan/rate-observations.mjs';
import {
  buildNextTenantState,
  createEmptyTenantState,
  tenantStateMaps,
} from '../src/state/tenant-state.mjs';

const NOW = new Date('2026-07-22T12:00:00.000Z');

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
          transient_error_ratio_threshold: 1,
          minimum_requests_for_ratio: 100,
          cooldown_minutes: 1440,
        },
      },
      monitoring: {
        suspicious_empty_baseline_minimum_jobs: 10,
        suspicious_empty_reprobe_minutes: 60,
        recent_successful_count_window: 4,
        degraded_minimum_attempts: 2,
        degraded_error_ratio: 0.5,
      },
    },
    providers: {
      ashby: { catalog_enabled: false },
      successfactors: {},
    },
  });
}

function sfTarget(sequence, variant, tenant, overrides = {}) {
  return {
    sequence,
    provider: 'successfactors',
    providerVariant: variant,
    healthPartition: `successfactors:${variant}`,
    tenant,
    targetClass: 'priority',
    healthOnly: false,
    canary: null,
    ...overrides,
  };
}

function providerResult(target, overrides = {}) {
  return {
    sequence: target.sequence,
    provider: target.provider,
    providerVariant: target.providerVariant,
    healthPartition: target.healthPartition,
    tenant: target.tenant,
    targetClass: target.targetClass,
    healthOnly: target.healthOnly,
    status: 'ok',
    skipReason: null,
    errorClass: null,
    errorMessage: null,
    httpStatus: null,
    jobsReturned: 20,
    candidatesMatched: 0,
    candidatesRetained: 0,
    candidatesDroppedByCap: 0,
    durationMs: 100,
    listingOutcome: 'listing_success_nonempty',
    acquisitionMode: variantMode(target.providerVariant),
    explicitTotal: 20,
    ...overrides,
  };
}

function variantMode(variant) {
  return variant === 'csb' ? 'csb-api' : 'rmk-html';
}

test('SuccessFactors variant detection recognizes CSB hosts and explicit RMK', () => {
  assert.equal(successFactorsVariant({ careers_url: 'https://gore.jobs.hr.cloud.sap/' }), 'csb');
  assert.equal(successFactorsVariant({ careers_url: 'https://careers.ey.com/ey/search/' }), 'rmk');
  assert.equal(successFactorsVariant({
    careers_url: 'https://gore.jobs.hr.cloud.sap/',
    sf_variant: 'rmk',
  }), 'rmk');
  assert.deepEqual(targetHealthIdentity({
    provider: 'successfactors',
    careers_url: 'https://gore.jobs.hr.cloud.sap/',
  }), {
    provider: 'successfactors',
    providerVariant: 'csb',
    healthPartition: 'successfactors:csb',
  });
  assert.equal(providerHealthPartition('ashby'), 'ashby');
  assert.throws(
    () => successFactorsVariant({ sf_variant: 'scp' }),
    /Unsupported SuccessFactors variant/,
  );
});

test('CSB breaker skips only CSB targets while RMK continues', async () => {
  const calls = [];
  const targets = [
    sfTarget(0, 'csb', 'csb-a'),
    sfTarget(1, 'csb', 'csb-b'),
    sfTarget(2, 'rmk', 'rmk-a'),
  ];
  const result = await executeProviderTargets({
    targets,
    policy: policy({ transientThreshold: 1 }),
    globalConcurrency: 1,
    fetchTarget: async (target) => {
      calls.push(`${target.providerVariant}:${target.tenant}`);
      if (target.providerVariant === 'csb') {
        const error = new Error('schema changed');
        error.code = 'CSB_LISTING_SCHEMA_MISMATCH';
        throw error;
      }
      return [];
    },
  });
  assert.deepEqual(calls, ['csb:csb-a', 'rmk:rmk-a']);
  assert.deepEqual(
    result.batches.map((batch) => batch.providerResult.status),
    ['error', 'skipped', 'ok'],
  );
  assert.equal(result.breakerEvents[0].healthPartition, 'successfactors:csb');
});

test('canary minimum creates a visible anomaly without applying job filters', async () => {
  const target = sfTarget(0, 'csb', 'canary', {
    healthOnly: true,
    canary: {
      minimumJobs: 1,
      detailSampleSize: 3,
      minimumDetailSuccesses: 1,
      intervalHours: 24,
    },
  });
  const result = await executeProviderTargets({
    targets: [target],
    policy: policy(),
    globalConcurrency: 1,
    fetchTarget: async () => ({
      jobs: [],
      providerTelemetry: {
        acquisitionMode: 'csb-api',
        listingOutcome: 'listing_success_explicit_empty',
        explicitTotal: 0,
      },
    }),
  });
  assert.equal(result.batches[0].providerResult.status, 'error');
  assert.equal(result.batches[0].providerResult.errorClass, 'provider_anomaly');
  assert.equal(result.batches[0].providerResult.listingOutcome, 'listing_volume_anomaly');
});

test('historically nonempty explicit zero gets a short re-probe before empty acceptance', () => {
  const target = sfTarget(0, 'csb', 'gore');
  const parsedPolicy = policy();
  let previousState = createEmptyTenantState(NOW);

  const seeded = buildNextTenantState({
    previousState,
    targets: [target],
    providerResults: [providerResult(target, { jobsReturned: 57, explicitTotal: 57 })],
    rateObservations: { providers: [] },
    policy: parsedPolicy,
    finishedAt: NOW,
  });
  previousState = seeded.state;

  const firstEmptyTime = new Date('2026-07-23T12:00:00.000Z');
  const first = buildNextTenantState({
    previousState,
    targets: [target],
    providerResults: [providerResult(target, {
      jobsReturned: 0,
      explicitTotal: 0,
      listingOutcome: 'listing_success_explicit_empty',
    })],
    rateObservations: { providers: [] },
    policy: parsedPolicy,
    finishedAt: firstEmptyTime,
  });
  const firstTenant = tenantStateMaps(first.state).tenants.get('successfactors:csb::gore');
  assert.equal(firstTenant.health, 'temporarily_failed');
  assert.equal(firstTenant.lastListingOutcome, 'listing_empty_anomaly');
  assert.equal(firstTenant.nextEligibleScanAtUtc, '2026-07-23T13:00:00.000Z');
  assert.deepEqual(firstTenant.recentSuccessfulCounts, [57]);

  const second = buildNextTenantState({
    previousState: first.state,
    targets: [target],
    providerResults: [providerResult(target, {
      jobsReturned: 0,
      explicitTotal: 0,
      listingOutcome: 'listing_success_explicit_empty',
    })],
    rateObservations: { providers: [] },
    policy: parsedPolicy,
    finishedAt: new Date('2026-07-23T13:00:00.000Z'),
  });
  const secondTenant = tenantStateMaps(second.state).tenants.get('successfactors:csb::gore');
  assert.equal(secondTenant.health, 'healthy');
  assert.equal(secondTenant.consecutiveEmptySuccesses, 1);
  assert.equal(secondTenant.consecutiveSuspiciousEmptyResults, 0);
  assert.deepEqual(secondTenant.recentSuccessfulCounts, [0]);

  const third = buildNextTenantState({
    previousState: second.state,
    targets: [target],
    providerResults: [providerResult(target, {
      jobsReturned: 0,
      explicitTotal: 0,
      listingOutcome: 'listing_success_explicit_empty',
    })],
    rateObservations: { providers: [] },
    policy: parsedPolicy,
    finishedAt: new Date('2026-07-24T13:00:00.000Z'),
  });
  const thirdTenant = tenantStateMaps(third.state).tenants.get('successfactors:csb::gore');
  assert.equal(thirdTenant.health, 'healthy');
  assert.equal(thirdTenant.lastListingOutcome, 'listing_success_explicit_empty');
});

test('historical volume collapse gets one re-probe and then establishes a new baseline', () => {
  const target = sfTarget(0, 'csb', 'volume-drop');
  const parsedPolicy = policy();
  const seeded = buildNextTenantState({
    previousState: createEmptyTenantState(NOW),
    targets: [target],
    providerResults: [providerResult(target, { jobsReturned: 57, explicitTotal: 57 })],
    rateObservations: { providers: [] },
    policy: parsedPolicy,
    finishedAt: NOW,
  });

  const first = buildNextTenantState({
    previousState: seeded.state,
    targets: [target],
    providerResults: [providerResult(target, { jobsReturned: 5, explicitTotal: 5 })],
    rateObservations: { providers: [] },
    policy: parsedPolicy,
    finishedAt: new Date('2026-07-23T12:00:00.000Z'),
  });
  const firstTenant = tenantStateMaps(first.state).tenants.get(
    'successfactors:csb::volume-drop',
  );
  assert.equal(firstTenant.health, 'temporarily_failed');
  assert.equal(firstTenant.lastListingOutcome, 'listing_volume_anomaly');
  assert.deepEqual(firstTenant.recentSuccessfulCounts, [57]);

  const second = buildNextTenantState({
    previousState: first.state,
    targets: [target],
    providerResults: [providerResult(target, { jobsReturned: 5, explicitTotal: 5 })],
    rateObservations: { providers: [] },
    policy: parsedPolicy,
    finishedAt: new Date('2026-07-23T13:00:00.000Z'),
  });
  const secondTenant = tenantStateMaps(second.state).tenants.get(
    'successfactors:csb::volume-drop',
  );
  assert.equal(secondTenant.health, 'healthy');
  assert.deepEqual(secondTenant.recentSuccessfulCounts, [5]);

  const third = buildNextTenantState({
    previousState: second.state,
    targets: [target],
    providerResults: [providerResult(target, { jobsReturned: 5, explicitTotal: 5 })],
    rateObservations: { providers: [] },
    policy: parsedPolicy,
    finishedAt: new Date('2026-07-24T13:00:00.000Z'),
  });
  const thirdTenant = tenantStateMaps(third.state).tenants.get(
    'successfactors:csb::volume-drop',
  );
  assert.equal(thirdTenant.health, 'healthy');
  assert.notEqual(thirdTenant.lastListingOutcome, 'listing_volume_anomaly');
});

test('provider state cooldown is persisted per SuccessFactors variant', () => {
  const csb = sfTarget(0, 'csb', 'gore');
  const rmk = sfTarget(1, 'rmk', 'ey');
  const result = buildNextTenantState({
    previousState: createEmptyTenantState(NOW),
    targets: [csb, rmk],
    providerResults: [providerResult(csb), providerResult(rmk)],
    rateObservations: {
      providers: [
        {
          provider: 'successfactors',
          providerVariant: 'csb',
          healthPartition: 'successfactors:csb',
          requestsAttempted: 1,
          rateLimited: 0,
        },
        {
          provider: 'successfactors',
          providerVariant: 'rmk',
          healthPartition: 'successfactors:rmk',
          requestsAttempted: 1,
          rateLimited: 0,
        },
      ],
    },
    breakerEvents: [{
      provider: 'successfactors',
      providerVariant: 'csb',
      healthPartition: 'successfactors:csb',
      reason: 'transient_error_threshold',
    }],
    policy: policy(),
    finishedAt: NOW,
  });
  const providers = tenantStateMaps(result.state).providers;
  assert.equal(providers.get('successfactors:csb').health, 'cooldown');
  assert.equal(providers.get('successfactors:rmk').health, 'healthy');
});

test('rate observations and summaries expose independent variant health', () => {
  const csb = sfTarget(0, 'csb', 'gore');
  const rmk = sfTarget(1, 'rmk', 'ey');
  const providerResults = [
    providerResult(csb, {
      status: 'error',
      errorClass: 'provider_schema',
      errorMessage: 'schema changed',
      jobsReturned: 0,
      listingOutcome: 'listing_schema_error',
    }),
    providerResult(rmk, { jobsReturned: 25, explicitTotal: null }),
  ];
  const parsedPolicy = policy();
  const observations = buildRateObservations({
    providerResults,
    policy: parsedPolicy,
  });
  assert.deepEqual(
    observations.providers.map((item) => item.healthPartition),
    ['successfactors:csb', 'successfactors:rmk'],
  );

  const summary = buildRunSummary({
    runId: 'run',
    mode: 'offline',
    startedAt: NOW,
    finishedAt: new Date(NOW.getTime() + 1000),
    targetPlan: {
      targets: [csb, rmk],
      counts: {
        priority: 2,
        canary: 0,
        normal: 0,
        disabled: 0,
        disabledRemoved: 0,
        planningRejected: 0,
        catalogEligible: 0,
        skippedNotDue: 0,
        skippedProviderCooldown: 0,
        skippedNormalBudget: 0,
        skippedTotal: 0,
      },
      limits: {},
      catalogs: { ashby: null },
      sweep: {
        targetFullSweepDays: 3,
        estimatedHealthySweepDays: 0,
        recommendedHealthyTargetsPerRun: 0,
        recommendedNormalTargetsPerRun: 0,
        feasibleAtConfiguredBudget: true,
      },
    },
    scanResult: {
      providerResults,
      breakerEvents: [],
      candidates: [],
      rejected: [],
      providerIds: ['successfactors'],
    },
    evaluated: [],
    rateObservations: observations,
    policy: parsedPolicy,
  });
  assert.equal(summary.providerVariants['successfactors:csb'].status, 'healthy');
  assert.equal(summary.providerVariants['successfactors:rmk'].status, 'healthy');
  assert.equal(summary.providerVariants['successfactors:csb'].errors, 1);
  assert.equal(summary.providerVariants['successfactors:rmk'].jobsReturned, 25);
});

test('provider canary result summarizes listing and detail independently', () => {
  const target = sfTarget(7, 'csb', 'gore', {
    name: 'Gore CSB canary',
    healthOnly: true,
    canary: {
      minimumJobs: 1,
      detailSampleSize: 3,
      minimumDetailSuccesses: 1,
      intervalHours: 24,
    },
  });
  const result = buildProviderCanaryResults({
    targets: [target],
    providerResults: [providerResult(target, { jobsReturned: 57 })],
    detailResults: [{
      provenance: { targetSequence: 7 },
      detail: { status: 'ok' },
    }],
    generatedAt: NOW,
  });
  assert.equal(result.canaries[0].status, 'healthy');
  assert.equal(result.canaries[0].listing.jobsReturned, 57);
  assert.equal(result.canaries[0].detail.successes, 1);
});

test('degraded canary preserves partial jobs for detail diagnostics', async () => {
  const target = sfTarget(0, 'csb', 'partial-canary', {
    healthOnly: true,
    canary: {
      minimumJobs: 10,
      detailSampleSize: 3,
      minimumDetailSuccesses: 1,
      intervalHours: 24,
    },
  });
  const jobs = Array.from({ length: 5 }, (_, index) => ({
    title: `Job ${index}`,
    url: `https://partial.jobs.hr.cloud.sap/job/job-${index}/${index}-en_US`,
  }));
  const result = await executeProviderTargets({
    targets: [target],
    policy: policy(),
    globalConcurrency: 1,
    fetchTarget: async () => ({
      jobs,
      providerTelemetry: {
        acquisitionMode: 'csb-api',
        listingOutcome: 'listing_success_nonempty',
        explicitTotal: 5,
      },
    }),
  });
  const batch = result.batches[0];
  assert.equal(batch.providerResult.status, 'error');
  assert.equal(batch.providerResult.errorClass, 'provider_anomaly');
  assert.equal(batch.providerResult.jobsReturned, 5);
  assert.equal(batch.providerResult.listingOutcome, 'listing_volume_anomaly');
  assert.equal(batch.jobs.length, 5);
});

test('variant summary remains degraded when planner skips every CSB target by cooldown', () => {
  const parsedPolicy = policy();
  const summary = buildRunSummary({
    runId: 'cooldown-run',
    mode: 'offline',
    startedAt: NOW,
    finishedAt: new Date(NOW.getTime() + 1000),
    targetPlan: {
      targets: [],
      healthPartitions: {
        'successfactors:csb': {
          provider: 'successfactors',
          providerVariant: 'csb',
          healthPartition: 'successfactors:csb',
          selectedTargets: 0,
          selectedCanaries: 0,
          selectedNormal: 0,
          skippedNotDue: 0,
          skippedProviderCooldown: 1,
          skippedNormalBudget: 0,
        },
      },
      counts: {
        priority: 0,
        canary: 0,
        normal: 0,
        disabled: 0,
        disabledRemoved: 0,
        planningRejected: 0,
        catalogEligible: 0,
        skippedNotDue: 0,
        skippedProviderCooldown: 1,
        skippedNormalBudget: 0,
        skippedTotal: 1,
      },
      limits: {},
      catalogs: { ashby: null },
      sweep: {
        targetFullSweepDays: 3,
        estimatedHealthySweepDays: 0,
        recommendedHealthyTargetsPerRun: 0,
        recommendedNormalTargetsPerRun: 0,
        feasibleAtConfiguredBudget: true,
      },
    },
    scanResult: {
      providerResults: [],
      breakerEvents: [],
      candidates: [],
      rejected: [],
      providerIds: ['successfactors'],
    },
    evaluated: [],
    policy: parsedPolicy,
  });
  const csb = summary.providerVariants['successfactors:csb'];
  assert.equal(csb.status, 'degraded');
  assert.equal(csb.targetsAttempted, 0);
  assert.equal(csb.skippedProviderCooldown, 1);
  assert.match(summary.providerHealthWarnings[0], /successfactors:csb/);
});

test('first variant-aware run migrates legacy shared SuccessFactors tenant state', () => {
  const parsedPolicy = policy();
  const legacyTarget = {
    sequence: 0,
    provider: 'successfactors',
    tenant: 'wlgore.jobs.hr.cloud.sap',
    targetClass: 'priority',
    healthOnly: false,
  };
  const legacyResult = {
    ...providerResult(sfTarget(0, 'csb', 'wlgore.jobs.hr.cloud.sap')),
    providerVariant: null,
    healthPartition: 'successfactors',
    jobsReturned: 57,
  };
  const legacy = buildNextTenantState({
    previousState: createEmptyTenantState(NOW),
    targets: [legacyTarget],
    providerResults: [legacyResult],
    rateObservations: {
      providers: [{
        provider: 'successfactors',
        providerVariant: null,
        healthPartition: 'successfactors',
        requestsAttempted: 1,
        rateLimited: 0,
      }],
    },
    policy: parsedPolicy,
    finishedAt: NOW,
  }).state;
  assert.ok(tenantStateMaps(legacy).tenants.has(
    'successfactors::wlgore.jobs.hr.cloud.sap',
  ));

  const csb = sfTarget(0, 'csb', 'wlgore.jobs.hr.cloud.sap');
  const migrated = buildNextTenantState({
    previousState: legacy,
    targets: [csb],
    providerResults: [providerResult(csb, { jobsReturned: 60 })],
    rateObservations: {
      providers: [{
        provider: 'successfactors',
        providerVariant: 'csb',
        healthPartition: 'successfactors:csb',
        requestsAttempted: 1,
        rateLimited: 0,
      }],
    },
    policy: parsedPolicy,
    finishedAt: new Date('2026-07-23T12:00:00.000Z'),
  }).state;
  const maps = tenantStateMaps(migrated);
  assert.equal(maps.tenants.has('successfactors::wlgore.jobs.hr.cloud.sap'), false);
  assert.equal(maps.tenants.get('successfactors:csb::wlgore.jobs.hr.cloud.sap').lastNonEmptyCount, 60);
  assert.equal(maps.providers.has('successfactors'), false);
  assert.equal(maps.providers.has('successfactors:csb'), true);
});

test('tenant-specific 404 failures do not degrade a SuccessFactors variant', () => {
  const parsedPolicy = policy();
  const first = sfTarget(0, 'rmk', 'dead-a');
  const second = sfTarget(1, 'rmk', 'dead-b');
  const providerResults = [first, second].map((target) => providerResult(target, {
    status: 'error',
    errorClass: 'http_4xx',
    httpStatus: 404,
    errorMessage: 'HTTP 404',
    jobsReturned: 0,
    listingOutcome: 'listing_error',
  }));
  const summary = buildRunSummary({
    runId: 'durable-run',
    mode: 'offline',
    startedAt: NOW,
    finishedAt: new Date(NOW.getTime() + 1000),
    targetPlan: {
      targets: [first, second],
      healthPartitions: {
        'successfactors:rmk': {
          provider: 'successfactors',
          providerVariant: 'rmk',
          healthPartition: 'successfactors:rmk',
          selectedTargets: 2,
          selectedCanaries: 0,
          selectedNormal: 0,
          skippedNotDue: 0,
          skippedProviderCooldown: 0,
          skippedNormalBudget: 0,
        },
      },
      counts: {
        priority: 2,
        canary: 0,
        normal: 0,
        disabled: 0,
        disabledRemoved: 0,
        planningRejected: 0,
        catalogEligible: 0,
        skippedNotDue: 0,
        skippedProviderCooldown: 0,
        skippedNormalBudget: 0,
        skippedTotal: 0,
      },
      limits: {},
      catalogs: { ashby: null },
      sweep: {
        targetFullSweepDays: 3,
        estimatedHealthySweepDays: 0,
        recommendedHealthyTargetsPerRun: 0,
        recommendedNormalTargetsPerRun: 0,
        feasibleAtConfiguredBudget: true,
      },
    },
    scanResult: {
      providerResults,
      breakerEvents: [],
      candidates: [],
      rejected: [],
      providerIds: ['successfactors'],
    },
    evaluated: [],
    policy: parsedPolicy,
  });
  const rmk = summary.providerVariants['successfactors:rmk'];
  assert.equal(rmk.status, 'healthy');
  assert.equal(rmk.errors, 2);
  assert.equal(rmk.healthErrors, 0);
  assert.equal(rmk.durableTenantFailures, 2);
  assert.deepEqual(summary.providerHealthWarnings, []);
});

test('degraded canary is scheduled for the short anomaly re-probe interval', () => {
  const target = sfTarget(0, 'csb', 'canary-reprobe', {
    healthOnly: true,
    canary: {
      minimumJobs: 10,
      detailSampleSize: 3,
      minimumDetailSuccesses: 1,
      intervalHours: 24,
    },
  });
  const result = providerResult(target, {
    status: 'error',
    errorClass: 'provider_anomaly',
    errorMessage: 'expected 10 jobs, received 5',
    jobsReturned: 5,
    listingOutcome: 'listing_volume_anomaly',
    explicitTotal: 5,
  });
  const next = buildNextTenantState({
    previousState: createEmptyTenantState(NOW),
    targets: [target],
    providerResults: [result],
    rateObservations: { providers: [] },
    policy: policy(),
    finishedAt: NOW,
  });
  const tenant = tenantStateMaps(next.state).tenants.get(
    'successfactors:csb::canary-reprobe',
  );
  assert.equal(tenant.health, 'temporarily_failed');
  assert.equal(tenant.nextEligibleScanAtUtc, '2026-07-22T13:00:00.000Z');
  assert.equal(tenant.consecutiveSuspiciousEmptyResults, 1);
});

test('attached canary can shorten tracked target cadence without duplicating scans', () => {
  const target = sfTarget(0, 'csb', 'shared-cadence', {
    healthOnly: false,
    canaryAttached: true,
    canary: {
      minimumJobs: 1,
      detailSampleSize: 1,
      minimumDetailSuccesses: 1,
      intervalHours: 6,
    },
  });
  const next = buildNextTenantState({
    previousState: createEmptyTenantState(NOW),
    targets: [target],
    providerResults: [providerResult(target, { jobsReturned: 20 })],
    rateObservations: { providers: [] },
    policy: policy(),
    finishedAt: NOW,
  });
  const tenant = tenantStateMaps(next.state).tenants.get(
    'successfactors:csb::shared-cadence',
  );
  assert.equal(tenant.nextEligibleScanAtUtc, '2026-07-22T18:00:00.000Z');
});

test('withdrawn canary detail samples are separated from parser errors', () => {
  const target = sfTarget(9, 'csb', 'gore', {
    name: 'Gore CSB canary',
    healthOnly: true,
    canary: {
      minimumJobs: 1,
      detailSampleSize: 3,
      minimumDetailSuccesses: 1,
      intervalHours: 24,
    },
  });
  const detailResults = Array.from({ length: 3 }, () => ({
    provenance: { targetSequence: 9 },
    detail: {
      status: 'error',
      error: 'SuccessFactors detail page reports that the job is unavailable',
    },
  }));
  const result = buildProviderCanaryResults({
    targets: [target],
    providerResults: [providerResult(target, { jobsReturned: 57 })],
    detailResults,
    generatedAt: NOW,
  });
  assert.equal(result.canaries[0].status, 'inconclusive');
  assert.equal(result.canaries[0].detail.status, 'inconclusive');
  assert.equal(result.canaries[0].detail.unavailable, 3);
  assert.equal(result.canaries[0].detail.errors, 0);
});

test('inconclusive canary detail remains visible without degrading a healthy listing partition', () => {
  const target = sfTarget(11, 'csb', 'gore-inconclusive', {
    name: 'Gore CSB canary',
    healthOnly: true,
    canary: {
      minimumJobs: 1,
      detailSampleSize: 2,
      minimumDetailSuccesses: 1,
      intervalHours: 24,
    },
  });
  const providerResults = [providerResult(target, { jobsReturned: 57 })];
  const canaryResults = buildProviderCanaryResults({
    targets: [target],
    providerResults,
    detailResults: Array.from({ length: 2 }, () => ({
      provenance: { targetSequence: 11 },
      detail: {
        status: 'error',
        error: 'SuccessFactors detail page reports that the job is unavailable',
      },
    })),
    generatedAt: NOW,
  });
  const summary = buildRunSummary({
    runId: 'inconclusive-canary',
    mode: 'offline',
    startedAt: NOW,
    finishedAt: new Date(NOW.getTime() + 1000),
    targetPlan: {
      targets: [target],
      healthPartitions: {
        'successfactors:csb': {
          provider: 'successfactors',
          providerVariant: 'csb',
          healthPartition: 'successfactors:csb',
          selectedTargets: 1,
          selectedCanaries: 1,
          selectedNormal: 0,
          skippedNotDue: 0,
          skippedProviderCooldown: 0,
          skippedNormalBudget: 0,
        },
      },
      counts: {
        priority: 1,
        canary: 1,
        normal: 0,
        disabled: 0,
        disabledRemoved: 0,
        planningRejected: 0,
        catalogEligible: 0,
        skippedNotDue: 0,
        skippedProviderCooldown: 0,
        skippedNormalBudget: 0,
        skippedTotal: 0,
      },
      limits: {},
      catalogs: { ashby: null },
      sweep: {
        targetFullSweepDays: 3,
        estimatedHealthySweepDays: 0,
        recommendedHealthyTargetsPerRun: 0,
        recommendedNormalTargetsPerRun: 0,
        feasibleAtConfiguredBudget: true,
      },
    },
    scanResult: {
      providerResults,
      breakerEvents: [],
      candidates: [],
      rejected: [],
      providerIds: ['successfactors'],
    },
    evaluated: [],
    canaryResults,
    policy: policy(),
  });
  assert.equal(summary.providerCanariesInconclusive, 1);
  assert.equal(summary.providerCanariesDegraded, 0);
  assert.equal(summary.providerVariants['successfactors:csb'].status, 'healthy');
  assert.deepEqual(summary.providerHealthWarnings, []);
  assert.match(summary.providerHealthNotices[0], /inconclusive detail samples/);
});
