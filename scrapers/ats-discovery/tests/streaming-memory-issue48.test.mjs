import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startLiveScanMonitor } from '../src/diagnostics/live-scan-monitor.mjs';
import { writeRunArtifacts } from '../src/artifacts/run-writer.mjs';
import { parseDiscoveryPolicy } from '../src/policy/discovery-policy.mjs';
import { executeProviderTargets } from '../src/scan/provider-executor.mjs';
import { runTrackedScan } from '../src/scan/tracked-source.mjs';

const policy = parseDiscoveryPolicy({
  schema_version: 1,
  defaults: { execution: { concurrency: 2, min_request_interval_ms: 0 } },
  providers: { ashby: {} },
});

function target(sequence) {
  return { sequence, provider: 'ashby', tenant: `tenant-${sequence}`, targetClass: 'normal' };
}

test('streamed provider batches remain ordered and bound the live result window', async () => {
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const delivered = [];
  const run = executeProviderTargets({
    targets: Array.from({ length: 30 }, (_, sequence) => target(sequence)),
    policy,
    globalConcurrency: 2,
    fetchTarget: async ({ sequence }) => {
      calls += 1;
      if (sequence === 0) await first;
      return [{ id: String(sequence) }];
    },
    onBatch: async ({ target: item, jobs }) => {
      delivered.push(item.sequence);
      assert.equal(jobs.length, 1);
    },
  });
  try {
    // The first target is blocked. Later completed targets must not
    // cause the executor to fetch the complete catalog into memory.
    for (let attempt = 0; attempt < 100 && calls < 4; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(calls <= 4, `started ${calls} targets before batch zero finished`);
    assert.deepEqual(delivered, []);
  } finally {
    releaseFirst();
  }
  const result = await run;
  assert.deepEqual(delivered, Array.from({ length: 30 }, (_, sequence) => sequence));
  assert.deepEqual(result.batches, []);
  assert.equal(calls, 30);
});

test('slow batch consumption applies backpressure to provider requests', async () => {
  let releaseConsumer;
  const consumer = new Promise((resolve) => { releaseConsumer = resolve; });
  let calls = 0;
  let consuming = false;
  const run = executeProviderTargets({
    targets: Array.from({ length: 40 }, (_, sequence) => target(sequence)),
    policy,
    globalConcurrency: 2,
    fetchTarget: async () => { calls += 1; return []; },
    onBatch: async () => {
      if (!consuming) {
        consuming = true;
        await consumer;
      }
    },
  });
  try {
    for (let attempt = 0; attempt < 100 && !consuming; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(consuming, true);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(calls <= 4, `started ${calls} targets while the consumer was blocked`);
  } finally {
    releaseConsumer();
  }
  await run;
  assert.equal(calls, 40);
});

test('streaming retains provider circuit decisions and partial listing results', async () => {
  const records = [];
  let calls = 0;
  const error = new Error('later page failed');
  error.partialJobs = [{ id: 'partial' }];
  const result = await executeProviderTargets({
    targets: Array.from({ length: 5 }, (_, sequence) => target(sequence)),
    policy: parseDiscoveryPolicy({
      schema_version: 1,
      defaults: {
        execution: { concurrency: 1, min_request_interval_ms: 0, breaker: {
          transient_error_threshold: 2,
        } },
      },
      providers: { ashby: {} },
    }),
    globalConcurrency: 1,
    fetchTarget: async () => { calls += 1; throw error; },
    onBatch: async (value) => { records.push(value); },
  });
  assert.equal(calls, 2);
  assert.deepEqual(records.map(({ providerResult }) => providerResult.status),
    ['error', 'error', 'skipped', 'skipped', 'skipped']);
  assert.equal(records[0].jobs.length, 1);
  assert.equal(result.breakerEvents.length, 1);
});

test('streamed scan preserves candidate order and processed counters', async () => {
  const updates = [];
  const targets = Array.from({ length: 8 }, (_, sequence) => ({
    ...target(sequence),
    name: `Tenant ${sequence}`,
    _provider: {
      id: 'ashby',
      fetch: async () => [{
        title: 'Product Manager',
        id: String(sequence),
        url: `https://example.test/jobs/${sequence}`,
        company: 'Example',
      }],
    },
  }));
  const result = await runTrackedScan({
    portalConfig: { title_filter: { positive: ['Product Manager'] }, max_posting_age_days: 30 },
    targets,
    providers: new Map([['ashby', targets[0]._provider]]),
    policy,
    concurrency: 2,
    nowMs: Date.parse('2026-10-31T12:00:00Z'),
    retainRejected: false,
    onBatchProcessed: async (value) => { updates.push(value); },
  });
  assert.equal(result.candidates.length, 8);
  assert.equal(updates.length, 8);
  assert.equal(updates.at(-1).rawJobsProcessed, 8);
  assert.equal(updates.at(-1).batchesProcessed, 8);
  assert.deepEqual(result.candidates.map((candidate) => candidate.provenance.targetSequence),
    [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('live monitor writes compact samples without relying on journal buffers', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ats-memory-trace-'));
  try {
    let memory = 25;
    const monitor = startLiveScanMonitor({
      journalPath: dir,
      intervalMs: 60_000,
      memoryUsage: () => ({ rss: memory, heapUsed: memory - 5, heapTotal: 40, external: 2 }),
    });
    monitor.update({ targetsFetched: 12, batchesProcessed: 9, rawJobsProcessed: 300 });
    memory = 35;
    monitor.sample();
    const summary = monitor.stop();
    assert.equal(summary.rssBytes, 35);
    assert.equal(summary.samplesWritten, 3);
    const rows = (await readFile(path.join(dir, 'resource-progress.ndjson'), 'utf8'))
      .trim().split('\n').map(JSON.parse);
    assert.equal(rows[1].targetsFetched, 12);
    assert.equal(rows[1].rawJobsProcessed, 300);
    assert.equal(rows.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('published runs keep the small resource trace', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ats-published-trace-'));
  try {
    const source = path.join(dir, 'source.ndjson');
    await writeFile(source, '{"heapUsedBytes":1234}\n');
    const runPath = await writeRunArtifacts({
      dataPath: dir,
      runId: 'memory-trace-test',
      metadata: {},
      resourceTracePath: source,
    });
    assert.equal(await readFile(path.join(runPath, 'resource-progress.ndjson'), 'utf8'),
      '{"heapUsedBytes":1234}\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
