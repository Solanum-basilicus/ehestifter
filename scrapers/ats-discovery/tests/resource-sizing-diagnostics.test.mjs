import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  measureRunDiskBytes, startLiveScanMonitor,
} from '../src/diagnostics/live-scan-monitor.mjs';
import { writeRunArtifacts } from '../src/artifacts/run-writer.mjs';
import { applyDiscoveryEligibility } from '../src/locations/discovery-eligibility.mjs';
import { normalizeCandidateLocations } from '../src/locations/normalizer.mjs';

async function withRunDirectory(worker) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ats-run-resource-'));
  const partial = path.join(root, 'runs', 'run-a.partial');
  try {
    await mkdir(partial, { recursive: true });
    return await worker({ root, partial });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('disk usage includes journal and staging but not other runs', async () => {
  await withRunDirectory(async ({ root, partial }) => {
    const staging = path.join(root, 'runs', '.run-a.123.tmp');
    const another = path.join(root, 'runs', 'run-b');
    await mkdir(staging);
    await mkdir(another);
    await writeFile(path.join(partial, 'one.ndjson'), 'x'.repeat(50));
    await writeFile(path.join(staging, 'two.json'), 'y'.repeat(70));
    await writeFile(path.join(another, 'other.json'), 'z'.repeat(1000));
    const result = measureRunDiskBytes({ journalPath: partial, runId: 'run-a' });
    assert.equal(result.partialBytes, 50);
    assert.equal(result.stagingBytes, 70);
    assert.equal(result.publishedBytes, 0);
    assert.equal(result.runBytes, 120);
    assert.ok(result.filesystemAvailableBytes > 0);
  });
});

test('live trace includes stage, CPU use, disk peak, and final memory sample', async () => {
  await withRunDirectory(async ({ partial }) => {
    let now = Date.parse('2026-11-03T12:00:00.000Z');
    let cpu = { user: 1000, system: 300 };
    let disk = 10;
    let available = 1000;
    const monitor = startLiveScanMonitor({
      journalPath: partial,
      intervalMs: 60_000,
      clock: () => now,
      memoryUsage: () => ({ rss: 42, heapUsed: 25, heapTotal: 55, external: 2 }),
      resourceUsage: () => ({ maxRSS: 72 }),
      cpuUsage: () => cpu,
      diskUsage: () => ({
        runBytes: disk, partialBytes: disk, filesystemAvailableBytes: available,
      }),
    });
    monitor.update({ stage: 'detail_enrichment', detailsCompleted: 17 });
    now += 1_000;
    cpu = { user: 1_100_000, system: 401_300 };
    disk = 200;
    available = 800;
    monitor.sample();
    monitor.update({ stage: 'location_normalization', geographyNormalized: 128 });
    now += 1_000;
    disk = 50;
    available = 900;
    const summary = monitor.stop();
    assert.equal(summary.runDiskBytes, 200);
    assert.equal(summary.filesystemMinAvailableBytes, 800);
    assert.equal(summary.cpuUserMicros, 1_100_000);
    assert.equal(summary.cpuSystemMicros, 401_300);
    assert.equal(summary.cpuCoresUsed, 1.5);
    assert.equal(summary.samplesWritten, 3);
    const entries = (await readFile(path.join(partial, 'resource-progress.ndjson'), 'utf8'))
      .trim().split('\n').map(JSON.parse);
    assert.equal(entries[1].stage, 'detail_enrichment');
    assert.equal(entries[1].detailsCompleted, 17);
    assert.equal(entries[1].runBytes, 200);
    assert.equal(entries[2].stage, 'location_normalization');
    assert.equal(entries[2].geographyNormalized, 128);
    assert.equal(entries[2].peakRssKiB, 72);
  });
});

test('disk measurement failure does not interrupt the monitor', async () => {
  await withRunDirectory(async ({ partial }) => {
    const monitor = startLiveScanMonitor({
      journalPath: partial,
      intervalMs: 60_000,
      diskUsage: () => { throw new Error('disk measurement failed'); },
    });
    const summary = monitor.stop();
    assert.equal(summary.diskError, 'disk measurement failed');
    assert.equal(summary.samplesWritten, 2);
  });
});

test('final geography reports progress without changing its output', () => {
  const candidates = Array.from({ length: 130 }, (_, index) => ({
    title: `Engineer ${index}`,
    rawLocation: 'Berlin, Germany',
    locations: [],
    matchedUserIds: ['user-1'],
  }));
  const progress = [];
  const normalized = normalizeCandidateLocations(candidates, {
    onProgress: (event) => {
      progress.push(event);
      if (event.current === 128) throw new Error('terminal not available');
    },
  });
  assert.equal(normalized.length, 130);
  assert.deepEqual(progress.map((event) => event.current), [128, 130]);
  const filtering = [];
  const result = applyDiscoveryEligibility(normalized, [{ userId: 'user-1' }], {
    onProgress: (event) => {
      filtering.push(event);
      if (event.current === 128) throw new Error('terminal not available');
    },
  });
  assert.equal(result.candidates.length, 130);
  assert.deepEqual(filtering.map((event) => event.current), [128, 130]);
});

test('publication records final trace and CPU/disk summary before rename', async () => {
  await withRunDirectory(async ({ root, partial }) => {
    const trace = path.join(partial, 'resource-progress.ndjson');
    await writeFile(trace, '{"stage":"provider_scan"}\n');
    const summary = { resourceMeasurements: {} };
    const phases = [];
    const published = await writeRunArtifacts({
      dataPath: root,
      runId: 'run-a',
      metadata: {},
      candidates: [{ title: 'Example' }],
      summary,
      resourceTracePath: trace,
      onBeforeSummary: async () => {
        phases.push('summary');
        summary.resourceMeasurements.runLive = { runDiskBytes: 130 };
      },
      onBeforeTraceCopy: async () => {
        phases.push('trace');
        await writeFile(trace, '{"stage":"artifact_publish"}\n', { flag: 'a' });
      },
    });
    assert.deepEqual(phases, ['summary', 'trace']);
    const savedSummary = JSON.parse(await readFile(path.join(published, 'summary.json'), 'utf8'));
    assert.equal(savedSummary.resourceMeasurements.runLive.runDiskBytes, 130);
    const savedTrace = await readFile(path.join(published, 'resource-progress.ndjson'), 'utf8');
    assert.match(savedTrace, /artifact_publish/);
  });
});
