import { randomUUID } from 'node:crypto';
import {
  mkdir,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';

import { writeJsonAtomic } from '../io/atomic-json.mjs';

export function createRunId(now = new Date()) {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
}

async function writeOptionalJobsArtifact(runPath, fileName, runId, jobs) {
  if (!jobs) return;
  await writeJsonAtomic(path.join(runPath, fileName), {
    schemaVersion: 1,
    runId,
    jobs,
  });
}

export async function writeRunArtifacts({
  dataPath,
  runId,
  metadata,
  targetPlan,
  providerResults,
  tenantStateChanges,
  rateObservations,
  canaryResults,
  userMatchResults,
  compatibilityResults,
  candidates,
  rejected,
  preflightResults,
  detailResults,
  locationResults,
  importResults,
  summary,
}) {
  const runsPath = path.join(dataPath, 'runs');
  const runPath = path.join(runsPath, runId);
  const stagingPath = path.join(
    runsPath,
    `.${runId}.${process.pid}.${randomUUID()}.tmp`,
  );

  await mkdir(runsPath, { recursive: true });
  await mkdir(stagingPath, { recursive: false });

  try {
    await writeJsonAtomic(path.join(stagingPath, 'metadata.json'), metadata);
    await writeJsonAtomic(path.join(stagingPath, 'target-plan.json'), targetPlan);
    await writeJsonAtomic(path.join(stagingPath, 'provider-results.json'), {
      schemaVersion: 2,
      runId,
      results: providerResults,
    });
    if (tenantStateChanges) {
      await writeJsonAtomic(
        path.join(stagingPath, 'tenant-state-changes.json'),
        { ...tenantStateChanges, runId },
      );
    }
    if (rateObservations) {
      await writeJsonAtomic(
        path.join(stagingPath, 'rate-observations.json'),
        { ...rateObservations, runId },
      );
    }
    if (canaryResults) {
      await writeJsonAtomic(
        path.join(stagingPath, 'provider-canary-results.json'),
        { ...canaryResults, runId },
      );
    }
    if (userMatchResults) {
      await writeJsonAtomic(
        path.join(stagingPath, 'user-match-results.json'),
        { ...userMatchResults, runId },
      );
    }
    if (compatibilityResults) {
      await writeJsonAtomic(
        path.join(stagingPath, 'compatibility-results.json'),
        { ...compatibilityResults, runId },
      );
    }
    await writeJsonAtomic(path.join(stagingPath, 'candidates.json'), {
      schemaVersion: 1,
      runId,
      jobs: candidates,
    });
    await writeJsonAtomic(path.join(stagingPath, 'rejected.json'), {
      schemaVersion: 1,
      runId,
      items: rejected,
    });

    await writeOptionalJobsArtifact(
      stagingPath,
      'preflight-results.json',
      runId,
      preflightResults,
    );
    await writeOptionalJobsArtifact(
      stagingPath,
      'detail-results.json',
      runId,
      detailResults,
    );
    await writeOptionalJobsArtifact(
      stagingPath,
      'location-results.json',
      runId,
      locationResults,
    );
    await writeOptionalJobsArtifact(
      stagingPath,
      'import-results.json',
      runId,
      importResults,
    );

    await writeJsonAtomic(path.join(stagingPath, 'summary.json'), summary);
    await rename(stagingPath, runPath);
    return runPath;
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
