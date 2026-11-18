import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeRunArtifacts } from '../src/artifacts/run-writer.mjs';
import { parseDiscoveryPolicy } from '../src/policy/discovery-policy.mjs';
import { classifyRuntimeFailure } from '../src/run-failure.mjs';
import { executeProviderTargets } from '../src/scan/provider-executor.mjs';

function policy() {
  return parseDiscoveryPolicy({
    schema_version: 1,
    defaults: {
      execution: {
        concurrency: 1,
        min_request_interval_ms: 0,
        breaker: { rate_limit_threshold: 1 },
      },
    },
    providers: { workday: {}, ashby: {} },
  });
}

function target(sequence, healthPartition = 'workday:wd3', targetClass = 'normal') {
  return {
    sequence,
    provider: healthPartition === 'ashby' ? 'ashby' : 'workday',
    healthPartition,
    tenant: `tenant-${sequence}`,
    targetClass,
  };
}

function rateLimit() {
  return Object.assign(new Error('HTTP 429'), { status: 429 });
}

async function execute(targets, { globalConcurrency = 2, streaming = true } = {}) {
  const fetched = [];
  const delivered = [];
  const reported = [];
  let skipped = 0;
  let peakOutstanding = 0;
  function sampleOutstanding() {
    peakOutstanding = Math.max(peakOutstanding,
      fetched.length + skipped - delivered.length);
  }
  const execution = await executeProviderTargets({
    targets,
    policy: policy(),
    globalConcurrency,
    fetchTarget: async (item) => {
      fetched.push(item.sequence);
      sampleOutstanding();
      if (item.provider === 'workday') throw rateLimit();
      return [{ id: String(item.sequence) }];
    },
    onResult: (result) => {
      reported.push(result.sequence);
      if (result.status === 'skipped') skipped += 1;
      sampleOutstanding();
    },
    onBatch: streaming ? async ({ target: item, providerResult, jobs }) => {
      // Yield while the other requests can finish.
      await new Promise((resolve) => setImmediate(resolve));
      delivered.push({ sequence: item.sequence, status: providerResult.status,
        skipReason: providerResult.skipReason, jobs: jobs.length });
    } : null,
  });
  if (streaming) {
    assert.deepEqual(execution.batches, []);
    assert.ok(peakOutstanding <= 2 * globalConcurrency);
  } else {
    for (const { target: item, providerResult, jobs } of execution.batches) {
      delivered.push({ sequence: item.sequence, status: providerResult.status,
        skipReason: providerResult.skipReason, jobs: jobs.length });
    }
  }
  assert.deepEqual(delivered.map((item) => item.sequence), targets.map((item) => item.sequence));
  assert.deepEqual([...reported].sort((a, b) => a - b), targets.map((item) => item.sequence));
  for (const item of delivered) {
    const wasFetched = fetched.includes(item.sequence);
    const healthy = targets[item.sequence].provider === 'ashby';
    assert.equal(item.status, healthy ? 'ok' : wasFetched ? 'error' : 'skipped');
    assert.equal(item.skipReason, wasFetched ? null : 'provider_circuit_open');
    assert.equal(item.jobs, healthy ? 1 : 0);
  }
  return { fetched, delivered, breakerEvents: execution.breakerEvents };
}

test('skips targets in an open circuit across multiple result windows', async () => {
  const result = await execute(Array.from({ length: 25 }, (_, i) => target(i)),
    { globalConcurrency: 1 });
  assert.deepEqual(result.fetched, [0]);
  assert.equal(result.breakerEvents.length, 1);
  assert.equal(result.breakerEvents[0].reason, 'rate_limit_threshold');
});

test('skips targets in two open circuits and continues healthy requests', async () => {
  const partitions = ['workday:wd3', 'workday:wd1', 'ashby'];
  const targets = Array.from({ length: 36 }, (_, i) => target(i,
    i < 2 ? partitions[i] : i === 2 || i === 19 || i >= 30 ? 'ashby' : partitions[i % 2]));
  const result = await execute(targets);
  assert.deepEqual([...result.fetched].sort((a, b) => a - b), [0, 1, 2, 19, 30, 31, 32, 33, 34, 35]);
  assert.deepEqual(result.breakerEvents.map((item) => item.healthPartition),
    ['workday:wd1', 'workday:wd3']);
});

test('keeps the circuit open after the priority group', async () => {
  const targets = Array.from({ length: 17 }, (_, i) => target(i, 'workday:wd3',
    i === 0 ? 'priority' : 'normal'));
  const result = await execute(targets);
  assert.deepEqual(result.fetched, [0]);
  assert.equal(result.breakerEvents.length, 1);
});

test('drains results when a circuit opens during batch processing', async () => {
  let releaseRequest;
  const requestGate = new Promise((resolve) => { releaseRequest = resolve; });
  let reportError;
  const errorReported = new Promise((resolve) => { reportError = resolve; });
  const fetched = [];
  const delivered = [];
  const targets = Array.from({ length: 18 }, (_, i) => target(i,
    i === 0 || i === 17 ? 'ashby' : 'workday:wd3'));
  const execution = await executeProviderTargets({
    targets,
    policy: policy(),
    globalConcurrency: 2,
    fetchTarget: async (item) => {
      fetched.push(item.sequence);
      if (item.sequence === 1) {
        await requestGate;
        throw rateLimit();
      }
      return [];
    },
    onResult: (result) => {
      if (result.sequence === 1) reportError();
    },
    onBatch: async ({ target: item, providerResult }) => {
      if (item.sequence === 0) {
        releaseRequest();
        assert.deepEqual(fetched, [0, 1]);
        await errorReported;
      }
      delivered.push([item.sequence, providerResult.status]);
    },
  });
  assert.deepEqual(fetched, [0, 1, 17]);
  assert.deepEqual(delivered, targets.map((item) => [item.sequence,
    item.sequence === 1 ? 'error' : item.provider === 'workday' ? 'skipped' : 'ok']));
  assert.equal(execution.breakerEvents.length, 1);
});

test('keeps ordered results without a batch callback', async () => {
  const result = await execute(Array.from({ length: 25 }, (_, i) => target(i)),
    { streaming: false });
  assert.deepEqual(result.fetched, [0]);
  assert.equal(result.breakerEvents.length, 1);
});

test('keeps the result window bounded for a large open circuit', async () => {
  const result = await execute(Array.from({ length: 2000 }, (_, i) => target(i)),
    { globalConcurrency: 4 });
  assert.deepEqual(result.fetched, [0]);
  assert.equal(result.breakerEvents.length, 1);
});

test('publishes a compact diagnostic when no target can start', async (t) => {
  const dataPath = await mkdtemp(path.join(os.tmpdir(), 'ats-provider-stall-'));
  t.after(() => rm(dataPath, { recursive: true, force: true }));
  let failure;
  await assert.rejects(executeProviderTargets({
    targets: [target(42)],
    policy: policy(),
    globalConcurrency: 2,
    // An invalid clock makes the queue unavailable without an active request.
    monotonicNow: () => NaN,
    fetchTarget: async () => { assert.fail('No request must start'); },
    onBatch: async () => { assert.fail('No batch must be ready'); },
  }), (error) => {
    assert.equal(error.code, 'PROVIDER_SCHEDULER_STALLED');
    failure = classifyRuntimeFailure(error, 'provider_scan');
    return true;
  });
  const runPath = await writeRunArtifacts({
    dataPath,
    runId: 'provider-stall',
    metadata: {},
    failure,
  });
  const published = JSON.parse(await readFile(path.join(runPath, 'failure.json'), 'utf8'));
  assert.deepEqual(published, failure);
  assert.equal(published.stage, 'provider_scan');
  assert.equal(published.outcome, 'failed_transient');
  assert.equal(published.retryable, true);
  assert.equal(published.exitCode, 1);
  assert.equal(published.error.chain[0].code, 'PROVIDER_SCHEDULER_STALLED');
  assert.equal(published.error.message,
    'provider scheduler stalled with pending targets (group=normal, nextIndex=0, '
    + 'nextSequence=42, nextCircuitOpen=false, groupTargets=1, active=0, completed=0, '
    + 'outstanding=0, windowLimit=4, pendingTargets=1, pendingOpenTargets=0, '
    + 'openPartitions=0, partitions=1)');
  assert.ok(published.error.message.length < 500);
  assert.doesNotMatch(JSON.stringify(published), /tenant-42|workday:wd3/u);
});
