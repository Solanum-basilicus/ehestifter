import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function createRunId(now = new Date()) {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, filePath);
}

export async function writeRunArtifacts({
  dataPath,
  runId,
  metadata,
  candidates,
  rejected,
  preflightResults,
  detailResults,
  locationResults,
  importResults,
  summary,
}) {
  const runPath = path.join(dataPath, 'runs', runId);
  await mkdir(runPath, { recursive: true });
  await writeJsonAtomic(path.join(runPath, 'metadata.json'), metadata);
  await writeJsonAtomic(path.join(runPath, 'candidates.json'), {
    schemaVersion: 1,
    runId,
    jobs: candidates,
  });
  await writeJsonAtomic(path.join(runPath, 'rejected.json'), {
    schemaVersion: 1,
    runId,
    items: rejected,
  });
  if (preflightResults) {
    await writeJsonAtomic(path.join(runPath, 'preflight-results.json'), {
      schemaVersion: 1,
      runId,
      jobs: preflightResults,
    });
  }
  if (detailResults) {
    await writeJsonAtomic(
      path.join(runPath, 'detail-results.json'),
      {
        schemaVersion: 1,
        runId,
        jobs: detailResults,
      },
    );
  }
  if (importResults) {
    await writeJsonAtomic(
      path.join(runPath, 'import-results.json'),
      {
        schemaVersion: 1,
        runId,
        jobs: importResults,
      },
    );
  }  
  if (locationResults) {
    await writeJsonAtomic(
      path.join(runPath, 'location-results.json'),
      {
        schemaVersion: 1,
        runId,
        jobs: locationResults,
      },
    );
  }
  await writeJsonAtomic(path.join(runPath, 'summary.json'), summary);
  return runPath;
}
