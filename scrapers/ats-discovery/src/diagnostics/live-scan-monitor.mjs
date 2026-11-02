import { appendFileSync } from 'node:fs';
import path from 'node:path';

// Keep a small independent trace that survives a fatal Node heap error.
// Do not use the buffered run journal for this diagnostic stream.
export function startLiveScanMonitor({
  journalPath,
  intervalMs = 30_000,
  clock = () => Date.now(),
  memoryUsage = () => process.memoryUsage(),
  append = appendFileSync,
} = {}) {
  if (typeof journalPath !== 'string' || !journalPath) {
    throw new Error('journalPath is required');
  }
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new Error('intervalMs must be a positive integer');
  }
  const filePath = path.join(journalPath, 'resource-progress.ndjson');
  const progress = {
    stage: 'provider_scan',
    targetsFetched: 0,
    batchesProcessed: 0,
    rawJobsProcessed: 0,
    candidatesRetained: 0,
    rejectedCount: 0,
  };
  const peak = { rssBytes: 0, heapUsedBytes: 0, heapTotalBytes: 0, externalBytes: 0 };
  const memoryKeys = {
    rssBytes: 'rss', heapUsedBytes: 'heapUsed',
    heapTotalBytes: 'heapTotal', externalBytes: 'external',
  };
  let written = 0;
  let writeError = null;
  let stopped = false;

  function sample() {
    if (stopped) return;
    const mem = memoryUsage();
    for (const key of Object.keys(peak)) {
      peak[key] = Math.max(peak[key], mem[memoryKeys[key]] ?? 0);
    }
    const entry = {
      atUtc: new Date(clock()).toISOString(),
      ...progress,
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
    };
    try {
      append(filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
      written += 1;
    } catch (error) {
      // Diagnostics must not stop ATS request processing.
      if (!writeError) {
        writeError = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Scan resource trace failed: ${writeError}\n`);
      }
    }
  }
  const timer = setInterval(sample, intervalMs);
  timer.unref();
  sample();
  return {
    update(values) {
      if (stopped) return;
      for (const key of Object.keys(progress)) {
        if (key === 'stage' && typeof values?.stage === 'string') {
          progress.stage = values.stage;
        } else if (key !== 'stage' && Number.isSafeInteger(values?.[key])
          && values[key] >= 0) {
          progress[key] = values[key];
        }
      }
    },
    sample,
    stop() {
      if (!stopped) {
        sample();
        stopped = true;
        clearInterval(timer);
      }
      return { ...peak, samplesWritten: written, writeError };
    },
  };
}
