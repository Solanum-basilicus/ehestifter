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
