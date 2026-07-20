import {
  mkdtemp,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { writeRunArtifacts } from '../src/artifacts/run-writer.mjs';
import { writeJsonAtomic } from '../src/io/atomic-json.mjs';
import { buildRunSummary } from '../src/run-summary.mjs';

async function withTempDir(worker) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'run-artifacts-'));
  try {
    return await worker(directory);
  } finally {
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

test('run writer emits target plan and provider result artifacts with envelopes', async () => {
  await withTempDir(async (directory) => {
    const runPath = await writeRunArtifacts({
      dataPath: directory,
      runId: 'run-1',
      metadata: { schemaVersion: 1 },
      targetPlan: {
        schemaVersion: 1,
        targets: [{ sequence: 0, tenant: 'n8n' }],
      },
      providerResults: [{ sequence: 0, status: 'ok' }],
      candidates: [],
      rejected: [],
      preflightResults: null,
      detailResults: null,
      locationResults: null,
      importResults: null,
      summary: { schemaVersion: 1 },
    });

    const plan = JSON.parse(await readFile(path.join(runPath, 'target-plan.json'), 'utf8'));
    const providerResults = JSON.parse(
      await readFile(path.join(runPath, 'provider-results.json'), 'utf8'),
    );
    assert.equal(plan.targets[0].tenant, 'n8n');
    assert.deepEqual(providerResults, {
      schemaVersion: 1,
      runId: 'run-1',
      results: [{ sequence: 0, status: 'ok' }],
    });
  });
});

test('run summary retains old metrics and adds Phase 2 target/provider metrics', () => {
  const summary = buildRunSummary({
    runId: 'run-1',
    mode: 'offline',
    startedAt: new Date('2026-07-20T00:00:00.000Z'),
    finishedAt: new Date('2026-07-20T00:00:01.000Z'),
    targetPlan: {
      targets: [{}, {}],
      counts: {
        priority: 1,
        normal: 1,
        disabled: 2,
        disabledRemoved: 1,
        planningRejected: 1,
      },
      catalogs: {
        ashby: {
          acceptedItemCount: 3000,
          rawSha256: 'a'.repeat(64),
        },
      },
    },
    scanResult: {
      candidates: [{ description: '' }],
      rejected: [{ reason: 'title_filter' }],
      providerIds: ['ashby'],
      providerResults: [
        {
          status: 'ok',
          errorClass: null,
          jobsReturned: 12,
        },
        {
          status: 'error',
          errorClass: 'rate_limited',
          jobsReturned: 0,
        },
      ],
    },
    evaluated: [{ description: '' }],
  });

  assert.equal(summary.targets, 2);
  assert.equal(summary.targetsPlanned, 2);
  assert.equal(summary.targetsAttempted, 2);
  assert.equal(summary.priorityTargets, 1);
  assert.equal(summary.normalTargets, 1);
  assert.equal(summary.providerSuccesses, 1);
  assert.equal(summary.providerErrors, 1);
  assert.equal(summary.providerRateLimited, 1);
  assert.equal(summary.rawJobsReturned, 12);
  assert.equal(summary.catalogAshbyItemCount, 3000);
  assert.equal(summary.candidates, 1);
  assert.equal(summary.rejected, 2);
  assert.equal(summary.candidateDescriptionsMissing, 1);
});
