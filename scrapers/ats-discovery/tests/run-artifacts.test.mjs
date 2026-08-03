import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { writeRunArtifacts } from '../src/artifacts/run-writer.mjs';
import { writeJsonAtomic } from '../src/io/atomic-json.mjs';
import { buildRunSummary } from '../src/run-summary.mjs';

async function withTempDir(worker) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'run-artifacts-'));
  try { return await worker(directory); } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('writeJsonAtomic replaces destination and leaves no temporary file', async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, 'value.json');
    await writeJsonAtomic(filePath, { version: 1 });
    await writeJsonAtomic(filePath, { version: 2 });
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), { version: 2 });
    assert.deepEqual(await readdir(directory), ['value.json']);
  });
});

test('run writer emits Phase 3 state and rate artifacts in one published directory', async () => {
  await withTempDir(async (directory) => {
    const runPath = await writeRunArtifacts({
      dataPath: directory,
      runId: 'run-1',
      metadata: { schemaVersion: 2 },
      targetPlan: { schemaVersion: 2, targets: [] },
      providerResults: [{ sequence: 0, status: 'ok' }],
      tenantStateChanges: { schemaVersion: 1, generatedAtUtc: '2026-07-20T00:00:00Z', tenantChanges: [], providerChanges: [] },
      rateObservations: { schemaVersion: 1, generatedAtUtc: '2026-07-20T00:00:00Z', providers: [] },
      candidates: [], rejected: [], preflightResults: null, detailResults: null,
      locationResults: null, importResults: null,
      summary: { schemaVersion: 2 },
    });
    const files = await readdir(runPath);
    assert.ok(files.includes('tenant-state-changes.json'));
    assert.ok(files.includes('rate-observations.json'));
    const provider = JSON.parse(await readFile(path.join(runPath, 'provider-results.json'), 'utf8'));
    assert.equal(provider.schemaVersion, 2);
  });
});

test('run directory is not visible until all artifact writes succeed', async () => {
  await withTempDir(async (directory) => {
    const runPath = await writeRunArtifacts({
      dataPath: directory, runId: 'run-atomic', metadata: {}, targetPlan: {}, providerResults: [],
      tenantStateChanges: null, rateObservations: null, candidates: [], rejected: [],
      preflightResults: null, detailResults: null, locationResults: null, importResults: null,
      summary: {},
    });
    assert.equal(path.basename(runPath), 'run-atomic');
    const runs = await readdir(path.join(directory, 'runs'));
    assert.deepEqual(runs, ['run-atomic']);
  });
});

test('run summary reports scheduling, breaker, sweep, and state metrics', () => {
  const summary = buildRunSummary({
    runId: 'run-1', mode: 'offline',
    startedAt: new Date('2026-07-20T00:00:00Z'),
    finishedAt: new Date('2026-07-20T00:00:01Z'),
    targetPlan: {
      targets: [{ lookbackStartUtc: '2026-07-17T00:00:00Z', lookbackUnbounded: false }],
      limits: { liveCatalogRequested: false, catalogTargetsRequested: 0 },
      counts: { priority: 0, normal: 1, disabled: 0, disabledRemoved: 0, planningRejected: 0,
        catalogEligible: 3000, skippedNotDue: 10, skippedProviderCooldown: 0,
        skippedNormalBudget: 2890, skippedTotal: 2900 },
      catalogs: { ashby: { acceptedItemCount: 3161, rawSha256: 'a'.repeat(64) } },
      sweep: { targetFullSweepDays: 3, estimatedHealthySweepDays: 30,
        recommendedHealthyTargetsPerRun: 1000, recommendedNormalTargetsPerRun: 1000,
        feasibleAtConfiguredBudget: false },
    },
    scanResult: {
      candidates: [], rejected: [], providerIds: ['ashby'],
      breakerEvents: [{ provider: 'ashby' }],
      providerResults: [{ status: 'skipped', skipReason: 'provider_circuit_open', errorClass: null, jobsReturned: 0 }],
    },
    evaluated: [],
    tenantStateChanges: { tenantChanges: [{ health: 'suspected_dead' }], providerChanges: [] },
    rateObservations: { providers: [{ recommendation: { action: 'decrease' } }] },
  });
  assert.equal(summary.targetsSkippedByCircuit, 1);
  assert.equal(summary.targetsSkippedBySchedule, 2900);
  assert.equal(summary.providerBreakersActivated, 1);
  assert.equal(summary.sweepRecommendedTargetsPerRun, 1000);
  assert.equal(summary.tenantsMarkedSuspectedDead, 1);
  assert.equal(summary.rateRecommendationsDecrease, 1);
});


test('Phase 4 summary quantifies catalog preflight ratio and scope rejections', () => {
  const summary = buildRunSummary({
    runId: 'run-live',
    mode: 'preflight',
    startedAt: new Date('2026-07-20T00:00:00Z'),
    finishedAt: new Date('2026-07-20T00:00:02Z'),
    targetPlan: {
      targets: [
        { lookbackStartUtc: null, lookbackUnbounded: false },
        { lookbackStartUtc: '2026-07-17T00:00:00Z', lookbackUnbounded: false },
      ],
      limits: { liveCatalogRequested: true, catalogTargetsRequested: 10 },
      counts: {
        priority: 1, normal: 1, disabled: 0, disabledRemoved: 0,
        planningRejected: 0, catalogEligible: 100, skippedNotDue: 0,
        skippedProviderCooldown: 0, skippedNormalBudget: 99, skippedTotal: 99,
      },
      catalogs: { ashby: { acceptedItemCount: 100, rawSha256: 'a'.repeat(64) } },
      sweep: {
        targetFullSweepDays: 3, estimatedHealthySweepDays: 100,
        recommendedHealthyTargetsPerRun: 34, recommendedNormalTargetsPerRun: 34,
        feasibleAtConfiguredBudget: false,
      },
    },
    scanResult: {
      candidates: [
        { sourceMode: 'priority' },
        { sourceMode: 'catalog' },
        { sourceMode: 'catalog' },
      ],
      rejected: [{ reason: 'location_scope_filter' }],
      providerIds: ['ashby'],
      breakerEvents: [],
      providerResults: [{
        status: 'ok', skipReason: null, errorClass: null, jobsReturned: 3,
        candidatesMatched: 3, candidatesDroppedByCap: 0,
      }],
    },
    evaluated: [
      { sourceMode: 'priority', preflight: { status: 'ok', exists: true } },
      { sourceMode: 'catalog', preflight: { status: 'ok', exists: true } },
      { sourceMode: 'catalog', preflight: { status: 'ok', exists: false } },
    ],
    requestedMaxCreates: null,
  });
  assert.equal(summary.schemaVersion, 3);
  assert.equal(summary.liveCatalogTargets, 1);
  assert.equal(summary.locationScopeRejected, 1);
  assert.equal(summary.preflightChecked, 3);
  assert.equal(summary.preflightExistingRatio, 0.6667);
  assert.equal(summary.catalogPreflightChecked, 2);
  assert.equal(summary.catalogPreflightExistingRatio, 0.5);
  assert.equal(summary.priorityCandidates, 1);
  assert.equal(summary.catalogCandidates, 2);
});

test('run writer emits provider canary artifact only when canaries were evaluated', async () => {
  await withTempDir(async (directory) => {
    const canaryResults = {
      schemaVersion: 1,
      generatedAtUtc: '2026-07-22T00:00:00.000Z',
      canaries: [{
        provider: 'successfactors',
        providerVariant: 'csb',
        healthPartition: 'successfactors:csb',
        tenant: 'wlgore.jobs.hr.cloud.sap',
        status: 'healthy',
      }],
      jobs: [],
    };
    const runPath = await writeRunArtifacts({
      dataPath: directory,
      runId: 'run-canary',
      metadata: {},
      targetPlan: {},
      providerResults: [],
      tenantStateChanges: null,
      rateObservations: null,
      canaryResults,
      candidates: [],
      rejected: [],
      preflightResults: null,
      detailResults: null,
      locationResults: null,
      importResults: null,
      summary: {},
    });
    const artifact = JSON.parse(await readFile(
      path.join(runPath, 'provider-canary-results.json'),
      'utf8',
    ));
    assert.equal(artifact.runId, 'run-canary');
    assert.equal(artifact.canaries[0].healthPartition, 'successfactors:csb');
  });
});

test('Phase 5B summary exposes independent per-catalog metrics', () => {
  const summary = buildRunSummary({
    runId: 'run-phase5b',
    mode: 'preflight',
    startedAt: new Date('2026-07-24T00:00:00Z'),
    finishedAt: new Date('2026-07-24T00:00:01Z'),
    targetPlan: {
      targets: [],
      limits: { liveCatalogRequested: true, catalogTargetsRequested: 4 },
      counts: {
        priority: 0, canary: 0, normal: 4, disabled: 0, disabledRemoved: 0,
        planningRejected: 0, canaryPlanningRejected: 0, catalogEligible: 40,
        skippedNotDue: 0, skippedProviderCooldown: 0, skippedNormalBudget: 36,
        skippedTotal: 36,
      },
      catalogs: {
        ashby: { acceptedItemCount: 10, rawSha256: 'a'.repeat(64), eligibleItemCount: 10, dueItemCount: 10, plannedTargetCount: 1 },
        greenhouse: { acceptedItemCount: 20, rawSha256: 'b'.repeat(64), eligibleItemCount: 20, dueItemCount: 20, plannedTargetCount: 1 },
        lever: { acceptedItemCount: 5, rawSha256: 'c'.repeat(64), eligibleItemCount: 5, dueItemCount: 5, plannedTargetCount: 1 },
        workday: { acceptedItemCount: 5, rawSha256: 'd'.repeat(64), eligibleItemCount: 5, dueItemCount: 5, plannedTargetCount: 1 },
      },
      catalogSweeps: {
        ashby: { targetFullSweepDays: 3 }, greenhouse: { targetFullSweepDays: 3 },
        lever: { targetFullSweepDays: 3 }, workday: { targetFullSweepDays: 3 },
      },
      healthPartitions: {},
      sweep: {
        targetFullSweepDays: 3, estimatedHealthySweepDays: 10,
        recommendedHealthyTargetsPerRun: 14, recommendedNormalTargetsPerRun: 14,
        feasibleAtConfiguredBudget: false,
      },
    },
    scanResult: {
      candidates: [
        { sourceMode: 'catalog', sourceProvider: 'greenhouse' },
        { sourceMode: 'catalog', sourceProvider: 'workday' },
      ],
      rejected: [], providerIds: ['ashby', 'greenhouse', 'lever', 'workday'],
      breakerEvents: [], providerResults: [],
    },
    evaluated: [
      { sourceMode: 'catalog', sourceProvider: 'greenhouse', preflight: { status: 'ok', exists: false } },
      { sourceMode: 'catalog', sourceProvider: 'workday', preflight: { status: 'ok', exists: true } },
    ],
  });
  assert.equal(summary.catalogs.greenhouse.itemCount, 20);
  assert.equal(summary.catalogs.greenhouse.plannedTargets, 1);
  assert.equal(summary.catalogs.greenhouse.candidates, 1);
  assert.equal(summary.catalogs.greenhouse.preflightMissing, 1);
  assert.equal(summary.catalogs.workday.preflightExisting, 1);
  assert.equal(summary.catalogs.lever.candidates, 0);
  assert.equal(summary.catalogAshbyItemCount, 10);
});

test('Phase 6 artifacts and summary expose bounded user matching and compatibility', async () => {
  await withTempDir(async (directory) => {
    const userMatchResults = {
      schemaVersion: 1,
      users: [{ userId: 'u1', validProfileCount: 1 }],
      matches: [{ url: 'https://example.test/1', matchedUserIds: ['u1'] }],
      rejectedNoUserMatch: [],
    };
    const compatibilityResults = {
      schemaVersion: 1,
      totalPairs: 2,
      evaluatedPairs: 2,
      omittedPairs: 0,
      results: [
        { status: 'requested' },
        { status: 'skipped_succeeded_current_cv' },
      ],
    };
    const runPath = await writeRunArtifacts({
      dataPath: directory,
      runId: 'run-phase6',
      metadata: {},
      targetPlan: {},
      providerResults: [],
      tenantStateChanges: null,
      rateObservations: null,
      canaryResults: null,
      userMatchResults,
      compatibilityResults,
      candidates: [],
      rejected: [],
      preflightResults: null,
      detailResults: null,
      locationResults: null,
      importResults: null,
      summary: {},
    });
    assert.ok((await readdir(runPath)).includes('user-match-results.json'));
    assert.ok((await readdir(runPath)).includes('compatibility-results.json'));
  });

  const summary = buildRunSummary({
    runId: 'run-phase6',
    mode: 'import',
    startedAt: new Date('2026-07-24T00:00:00Z'),
    finishedAt: new Date('2026-07-24T00:00:01Z'),
    targetPlan: {
      targets: [],
      limits: {},
      counts: {
        priority: 0, canary: 0, normal: 0, disabled: 0,
        disabledRemoved: 0, planningRejected: 0, canaryPlanningRejected: 0,
        catalogEligible: 0, skippedNotDue: 0, skippedProviderCooldown: 0,
        skippedNormalBudget: 0, skippedTotal: 0,
      },
      catalogs: {},
      healthPartitions: {},
      sweep: {
        targetFullSweepDays: 3,
        estimatedHealthySweepDays: null,
        recommendedHealthyTargetsPerRun: 0,
        recommendedNormalTargetsPerRun: 0,
        feasibleAtConfiguredBudget: true,
      },
    },
    scanResult: {
      candidates: [{
        sourceMode: 'catalog',
        matchedUserIds: ['u1', 'u2'],
      }],
      rejected: [{ reason: 'no_user_match' }],
      providerIds: [],
      breakerEvents: [],
      providerResults: [],
    },
    evaluated: [],
    discoveryUsers: [
      { hasSavedFilters: false, profiles: [] },
      { hasSavedFilters: true, profiles: [] },
    ],
    userMatchResults: { matches: [{}] },
    compatibilityResults: {
      totalPairs: 3,
      evaluatedPairs: 2,
      omittedPairs: 1,
      results: [
        { status: 'requested' },
        { status: 'error_request' },
      ],
    },
    targetsSkippedNoEligibleUsers: 4,
  });
  assert.equal(summary.multiUserEnabled, true);
  assert.equal(summary.discoveryUsersEligible, 2);
  assert.equal(summary.discoveryUsersFailingClosed, 1);
  assert.equal(summary.candidatesRejectedNoUserMatch, 1);
  assert.equal(summary.userCandidateMatches, 2);
  assert.equal(summary.targetsSkippedNoEligibleUsers, 4);
  assert.equal(summary.compatibilityPairs, 3);
  assert.equal(summary.compatibilityRequested, 1);
  assert.equal(summary.compatibilityErrors, 1);
  assert.equal(summary.discoveryUsersLoadStatus, 'ok');
});

test('Phase 6 summary reports Users API failure without pretending multi-user is disabled', () => {
  const summary = buildRunSummary({
    runId: 'run-phase6-users-error',
    mode: 'offline',
    startedAt: new Date('2026-07-24T00:00:00Z'),
    finishedAt: new Date('2026-07-24T00:00:01Z'),
    targetPlan: {
      targets: [],
      limits: {},
      counts: {
        priority: 0, canary: 0, normal: 0, disabled: 0,
        disabledRemoved: 0, planningRejected: 0, canaryPlanningRejected: 0,
        catalogEligible: 0, skippedNotDue: 0, skippedProviderCooldown: 0,
        skippedNormalBudget: 0, skippedTotal: 0,
      },
      catalogs: {},
      healthPartitions: {},
      sweep: {
        targetFullSweepDays: 3,
        estimatedHealthySweepDays: null,
        recommendedHealthyTargetsPerRun: 0,
        recommendedNormalTargetsPerRun: 0,
        feasibleAtConfiguredBudget: true,
      },
    },
    scanResult: {
      candidates: [], rejected: [], providerIds: [], breakerEvents: [],
      providerResults: [],
    },
    evaluated: [],
    discoveryUsers: null,
    multiUserEnabled: true,
    discoveryUsersError: 'Users API unavailable',
    targetsSkippedNoEligibleUsers: 12,
  });
  assert.equal(summary.multiUserEnabled, true);
  assert.equal(summary.discoveryUsersLoadStatus, 'error');
  assert.equal(summary.discoveryUsersEligible, 0);
  assert.equal(summary.discoveryUsersWithSavedFilters, 0);
  assert.equal(summary.targetsSkippedNoEligibleUsers, 12);
});

test('run summary separates unavailable details and their safe import skips', () => {
  const evaluated = [{
    sourceMode: 'priority',
    sourceProvider: 'workday',
    description: '',
    preflight: { status: 'ok', exists: false },
    detail: { status: 'unavailable', responseStatus: 404 },
    import: { status: 'skipped_detail_unavailable', responseStatus: 404 },
  }];
  const summary = buildRunSummary({
    runId: 'workday-unavailable',
    mode: 'import',
    requestedMaxCreates: 1,
    startedAt: new Date('2026-08-03T12:00:00Z'),
    finishedAt: new Date('2026-08-03T12:00:01Z'),
    targetPlan: {
      targets: [],
      limits: { liveCatalogRequested: false, catalogTargetsRequested: 0 },
      counts: {
        priority: 0,
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
      catalogs: {},
      sweep: {},
    },
    scanResult: {
      candidates: evaluated,
      rejected: [],
      providerIds: ['workday'],
      breakerEvents: [],
      providerResults: [],
    },
    evaluated,
    tenantStateChanges: { tenantChanges: [], providerChanges: [] },
    rateObservations: { providers: [] },
  });

  assert.equal(summary.detailUnavailable, 1);
  assert.equal(summary.detailErrors, 0);
  assert.equal(summary.missingDescriptionsForImport, 0);
  assert.equal(summary.importDetailUnavailableSkipped, 1);
  assert.equal(summary.importSkipped, 1);
});
