import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { classifyPrerequisiteFailure } from '../src/run-failure.mjs';
import { publishPrerequisiteFailureRun } from '../src/prerequisite-failure-run.mjs';

function emptyPlan(runId) {
  return {
    schemaVersion: 3,
    runId,
    targets: [],
    counts: {
      priority: 0,
      canary: 0,
      normal: 0,
      disabled: 0,
      disabledRemoved: 0,
      planningRejected: 0,
      canaryPlanningRejected: 0,
      catalogEligible: 0,
      skippedNotDue: 0,
      skippedProviderCooldown: 0,
      skippedNormalBudget: 0,
      skippedTotal: 0,
    },
    limits: {
      liveCatalogRequested: true,
      catalogTargetsRequested: 23,
    },
    sweep: {
      targetFullSweepDays: 2,
      estimatedHealthySweepDays: 0,
      recommendedHealthyTargetsPerRun: 0,
      recommendedNormalTargetsPerRun: 0,
      feasibleAtConfiguredBudget: true,
    },
    catalogs: {
      ashby: null,
      greenhouse: null,
      lever: null,
      workday: null,
    },
    catalogSweeps: {},
    healthPartitions: {},
  };
}

test('publishes prerequisite failure evidence without provider observations', async (t) => {
  const dataPath = await mkdtemp(path.join(os.tmpdir(), 'ats-run-failure-'));
  t.after(() => rm(dataPath, { recursive: true, force: true }));

  const runId = '2026-07-31T07-55-49-000Z-test';
  const failure = classifyPrerequisiteFailure(
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('route unavailable'), {
        code: 'ENETUNREACH',
      }),
    }),
  );
  const output = await publishPrerequisiteFailureRun({
    args: { mode: 'import', maxCreate: 1 },
    config: {
      paths: { data: dataPath },
      configPath: '/config/scanner.local.json',
      careerOps: { upstreamRef: 'test' },
      multiUser: {
        portalFiltersMode: 'per_user',
        compatibility: { enabled: true },
      },
    },
    runId,
    startedAt: new Date('2026-07-31T07:55:49.000Z'),
    planning: {
      plan: emptyPlan(runId),
      policy: null,
      tenantState: { updatedAtUtc: null },
      planningRejections: [],
    },
    providers: new Map([['workday', {}]]),
    requestedCatalogTargets: 23,
    failure,
  });

  assert.equal(output.summary.runStatus, 'aborted_retryable');
  assert.equal(output.summary.targetsAttempted, 0);
  assert.deepEqual(output.summary.providerVariants, {});
  assert.deepEqual(
    JSON.parse(await readFile(path.join(output.runPath, 'failure.json'), 'utf8')),
    failure,
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(output.runPath, 'provider-results.json'), 'utf8')).results,
    [],
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(output.runPath, 'candidates.json'), 'utf8')).jobs,
    [],
  );
});
