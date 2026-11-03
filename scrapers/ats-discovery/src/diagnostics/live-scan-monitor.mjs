import { appendFileSync, readdirSync, statSync, statfsSync } from 'node:fs';
import path from 'node:path';

// Count only files for this run. A completed run and its staging copy can
// exist at the same time. Do not include files from other runs.
export function measureRunDiskBytes({ journalPath, runId }) {
  const runsPath = path.dirname(journalPath);
  const names = readdirSync(runsPath, { withFileTypes: true });
  const result = { partialBytes: 0, stagingBytes: 0, publishedBytes: 0 };
  function directoryBytes(directory) {
    let bytes = 0;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const itemPath = path.join(directory, entry.name);
      if (entry.isDirectory()) bytes += directoryBytes(itemPath);
      else if (entry.isFile()) bytes += statSync(itemPath).size;
    }
    return bytes;
  }
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    let key = null;
    if (entry.name === `${runId}.partial`) key = 'partialBytes';
    else if (entry.name === runId) key = 'publishedBytes';
    else if (entry.name.startsWith(`.${runId}.`) && entry.name.endsWith('.tmp')) {
      key = 'stagingBytes';
    }
    if (key) result[key] += directoryBytes(path.join(runsPath, entry.name));
  }
  const { bsize, bavail } = statfsSync(runsPath);
  return {
    ...result,
    runBytes: result.partialBytes + result.stagingBytes + result.publishedBytes,
    filesystemAvailableBytes: bsize * bavail,
  };
}

// Write a small independent trace that survives a fatal Node heap error.
// Disk sizes and memory peaks are sampled, not exact high-water marks.
export function startLiveScanMonitor({
  journalPath,
  runId = path.basename(journalPath ?? '').replace(/\.partial$/u, ''),
  intervalMs = 30_000,
  clock = () => Date.now(),
  memoryUsage = () => process.memoryUsage(),
  cpuUsage = () => process.cpuUsage(),
  resourceUsage = () => process.resourceUsage(),
  diskUsage = () => measureRunDiskBytes({ journalPath, runId }),
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
    preflightCompleted: 0,
    detailsCompleted: 0,
    geographyNormalized: 0,
    geographyEvaluated: 0,
    importsCompleted: 0,
    compatibilityCompleted: 0,
  };
  const peak = {
    rssBytes: 0, heapUsedBytes: 0, heapTotalBytes: 0,
    externalBytes: 0, runDiskBytes: 0, cpuCoresUsed: 0,
    filesystemMinAvailableBytes: null,
  };
  const memoryKeys = {
    rssBytes: 'rss', heapUsedBytes: 'heapUsed',
    heapTotalBytes: 'heapTotal', externalBytes: 'external',
  };
  let written = 0;
  let writeError = null;
  let diskError = null;
  let stopped = false;
  let previous = null;
  let last = null;

  function snapshot() {
    return {
      ...peak,
      samplesWritten: written,
      writeError,
      diskError,
      cpuUserMicros: last?.cpuUserMicros ?? 0,
      cpuSystemMicros: last?.cpuSystemMicros ?? 0,
      runDiskCurrentBytes: last?.runDiskBytes ?? null,
      filesystemAvailableBytes: last?.filesystemAvailableBytes ?? null,
    };
  }

  function sample() {
    if (stopped) return;
    const mem = memoryUsage();
    const cpu = cpuUsage();
    const time = clock();
    const ru = resourceUsage();
    let disk = {};
    try {
      disk = diskUsage();
    } catch (error) {
      // Disk measurement must not interrupt discovery or artifact writing.
      if (!diskError) diskError = error instanceof Error ? error.message : String(error);
    }
    for (const key of Object.keys(memoryKeys)) {
      peak[key] = Math.max(peak[key], mem[memoryKeys[key]] ?? 0);
    }
    if (Number.isFinite(disk.runBytes)) {
      peak.runDiskBytes = Math.max(peak.runDiskBytes, disk.runBytes);
    }
    if (Number.isFinite(disk.filesystemAvailableBytes)) {
      peak.filesystemMinAvailableBytes = peak.filesystemMinAvailableBytes == null
        ? disk.filesystemAvailableBytes
        : Math.min(peak.filesystemMinAvailableBytes, disk.filesystemAvailableBytes);
    }
    const elapsedMs = previous ? Math.max(0, time - previous.time) : 0;
    const cpuDeltaMicros = previous
      ? Math.max(0, cpu.user - previous.cpu.user)
        + Math.max(0, cpu.system - previous.cpu.system)
      : 0;
    // Very short intervals can exaggerate CPU use because the wall clock
    // has millisecond precision. Report a rate only for useful intervals.
    const cpuCoresUsed = elapsedMs >= 1_000
      ? Number((cpuDeltaMicros / (elapsedMs * 1000)).toFixed(3)) : null;
    if (cpuCoresUsed !== null) {
      peak.cpuCoresUsed = Math.max(peak.cpuCoresUsed, cpuCoresUsed);
    }
    previous = { cpu, time };
    const entry = {
      atUtc: new Date(time).toISOString(),
      ...progress,
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
      peakRssKiB: ru.maxRSS,
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
      cpuCoresUsed,
      cpuSampleWindowMs: elapsedMs,
      ...disk,
    };
    last = entry;
    try {
      append(filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
      written += 1;
    } catch (error) {
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
    snapshot,
    stop() {
      if (!stopped) {
        sample();
        stopped = true;
        clearInterval(timer);
      }
      return snapshot();
    },
  };
}
