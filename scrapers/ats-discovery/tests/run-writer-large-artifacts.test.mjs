import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  writeJsonArrayEnvelopeAtomic,
} from '../src/io/atomic-json.mjs';
import { writeRunArtifacts } from '../src/artifacts/run-writer.mjs';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ats-run-writer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('array envelope writer streams iterable items into ordinary atomic JSON', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = path.join(directory, 'streamed.json');
  const items = Array.from({ length: 10_000 }, (_, index) => ({ index }));
  items.toJSON = () => {
    throw new Error('the complete array must not be stringified');
  };

  await writeJsonArrayEnvelopeAtomic(filePath, {
    header: { schemaVersion: 1, runId: 'run-1' },
    arrayProperty: 'items',
    items,
  });

  const parsed = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.runId, 'run-1');
  assert.equal(parsed.items.length, 10_000);
  assert.deepEqual(parsed.items.at(-1), { index: 9_999 });
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.endsWith('.tmp')),
    [],
  );
});

test('run writer streams compact rejection diagnostics without full descriptions', async (t) => {
  const dataPath = await temporaryDirectory(t);
  const rejected = [{
    reason: 'title_filter',
    candidate: {
      schemaVersion: 1,
      sourceMode: 'catalog',
      sourceProvider: 'workday',
      sourceProviderVariant: null,
      sourceTenant: 'example.wd1.myworkdayjobs.com/site',
      sourceCompany: 'Example',
      url: 'https://example.test/job/1',
      title: 'Unrelated role',
      hiringCompanyName: 'Example',
      rawLocation: 'Berlin',
      remoteType: 'Unknown',
      postedAtUtc: '2026-07-28T00:00:00.000Z',
      description: 'x'.repeat(5_000_000),
      descriptionStatus: 'provider-list',
      provenance: {
        providerNativeId: '1',
        acquisitionMode: 'workday-cxs',
        healthPartition: 'workday',
        targetSequence: 42,
        targetReason: 'workday_catalog',
        lookbackStartUtc: '2026-07-26T00:00:00.000Z',
        catalog: { deliberately: 'not repeated in rejection diagnostics' },
      },
    },
    details: { positiveMatches: [] },
  }];
  rejected.toJSON = () => {
    throw new Error('the complete rejection array must not be stringified');
  };

  const runPath = await writeRunArtifacts({
    dataPath,
    runId: 'run-1',
    metadata: { schemaVersion: 1 },
    targetPlan: { schemaVersion: 1 },
    providerResults: [],
    tenantStateChanges: null,
    rateObservations: null,
    canaryResults: null,
    userMatchResults: null,
    compatibilityResults: null,
    candidates: [],
    rejected,
    preflightResults: null,
    detailResults: null,
    locationResults: null,
    importResults: null,
    summary: { schemaVersion: 1, runId: 'run-1' },
  });

  const artifactText = await readFile(path.join(runPath, 'rejected.json'), 'utf8');
  const artifact = JSON.parse(artifactText);
  assert.equal(artifact.candidateShape, 'diagnostic-v1');
  assert.equal(artifact.items.length, 1);
  assert.equal(artifact.items[0].candidate.url, 'https://example.test/job/1');
  assert.equal(artifact.items[0].candidate.description, undefined);
  assert.equal(artifact.items[0].candidate.provenance.catalog, undefined);
  assert.ok(artifactText.length < 5_000);
});

test('run writer names the artifact that failed and removes staging data', async (t) => {
  const dataPath = await temporaryDirectory(t);
  const rejected = [{ reason: 'bad', candidate: { url: 'https://example.test' } }];
  rejected[0].toJSON = () => {
    throw new Error('synthetic serialization failure');
  };

  await assert.rejects(
    writeRunArtifacts({
      dataPath,
      runId: 'run-bad',
      metadata: {},
      targetPlan: {},
      providerResults: [],
      tenantStateChanges: null,
      rateObservations: null,
      canaryResults: null,
      userMatchResults: null,
      compatibilityResults: null,
      candidates: [],
      rejected,
      preflightResults: null,
      detailResults: null,
      locationResults: null,
      importResults: null,
      summary: {},
    }),
    /Failed to write run artifact rejected\.json: synthetic serialization failure/,
  );

  const runsPath = path.join(dataPath, 'runs');
  assert.deepEqual(await readdir(runsPath), []);
});
