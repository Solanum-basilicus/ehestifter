import { randomUUID } from 'node:crypto';
import {
  mkdir,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';

import {
  writeJsonArrayEnvelopeAtomic,
  writeJsonAtomic,
} from '../io/atomic-json.mjs';

export function createRunId(now = new Date()) {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
}

async function writeArtifact(stagingPath, fileName, writer) {
  try {
    await writer(path.join(stagingPath, fileName));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to write run artifact ${fileName}: ${message}`, {
      cause: error,
    });
  }
}

async function writeJsonArtifact(stagingPath, fileName, value) {
  await writeArtifact(
    stagingPath,
    fileName,
    (filePath) => writeJsonAtomic(filePath, value),
  );
}

async function writeArrayArtifact(
  stagingPath,
  fileName,
  header,
  arrayProperty,
  items,
) {
  await writeArtifact(
    stagingPath,
    fileName,
    (filePath) => writeJsonArrayEnvelopeAtomic(filePath, {
      header,
      arrayProperty,
      items,
    }),
  );
}

async function writeOptionalJobsArtifact(
  runPath,
  fileName,
  runId,
  jobs,
  schemaVersion = 1,
) {
  if (!jobs) return;
  await writeArrayArtifact(
    runPath,
    fileName,
    { schemaVersion, runId },
    'jobs',
    jobs,
  );
}

function rejectionCandidateForArtifact(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return candidate ?? null;
  }
  return {
    schemaVersion: candidate.schemaVersion ?? 1,
    sourceMode: candidate.sourceMode ?? null,
    sourceProvider: candidate.sourceProvider ?? null,
    sourceProviderVariant: candidate.sourceProviderVariant ?? null,
    sourceTenant: candidate.sourceTenant ?? null,
    sourceCompany: candidate.sourceCompany ?? null,
    url: candidate.url ?? null,
    title: candidate.title ?? null,
    hiringCompanyName: candidate.hiringCompanyName ?? null,
    rawLocation: candidate.rawLocation ?? null,
    remoteType: candidate.remoteType ?? null,
    postedAtUtc: candidate.postedAtUtc ?? null,
    descriptionStatus: candidate.descriptionStatus ?? null,
    provenance: candidate.provenance ? {
      providerNativeId: candidate.provenance.providerNativeId ?? null,
      acquisitionMode: candidate.provenance.acquisitionMode ?? null,
      healthPartition: candidate.provenance.healthPartition ?? null,
      targetSequence: candidate.provenance.targetSequence ?? null,
      targetReason: candidate.provenance.targetReason ?? null,
      lookbackStartUtc: candidate.provenance.lookbackStartUtc ?? null,
    } : null,
  };
}

function* rejectedItemsForArtifact(items) {
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      yield item;
      continue;
    }
    yield {
      ...item,
      candidate: rejectionCandidateForArtifact(item.candidate),
    };
  }
}

export async function writeRunArtifacts({
  dataPath,
  runId,
  metadata,
  failure = null,
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
    await writeJsonArtifact(stagingPath, 'metadata.json', metadata);
    if (failure) {
      await writeJsonArtifact(stagingPath, 'failure.json', failure);
    }
    await writeJsonArtifact(stagingPath, 'target-plan.json', targetPlan);
    await writeArrayArtifact(
      stagingPath,
      'provider-results.json',
      { schemaVersion: 2, runId },
      'results',
      providerResults,
    );
    if (tenantStateChanges) {
      await writeJsonArtifact(
        stagingPath,
        'tenant-state-changes.json',
        { ...tenantStateChanges, runId },
      );
    }
    if (rateObservations) {
      await writeJsonArtifact(
        stagingPath,
        'rate-observations.json',
        { ...rateObservations, runId },
      );
    }
    if (canaryResults) {
      await writeJsonArtifact(
        stagingPath,
        'provider-canary-results.json',
        { ...canaryResults, runId },
      );
    }
    if (userMatchResults) {
      await writeJsonArtifact(
        stagingPath,
        'user-match-results.json',
        { ...userMatchResults, runId },
      );
    }
    if (compatibilityResults) {
      await writeJsonArtifact(
        stagingPath,
        'compatibility-results.json',
        { ...compatibilityResults, runId },
      );
    }
    await writeArrayArtifact(
      stagingPath,
      'candidates.json',
      { schemaVersion: 1, runId },
      'jobs',
      candidates,
    );
    await writeArtifact(
      stagingPath,
      'rejected.json',
      (filePath) => writeJsonArrayEnvelopeAtomic(filePath, {
        header: {
          schemaVersion: 1,
          runId,
          candidateShape: 'diagnostic-v1',
        },
        arrayProperty: 'items',
        items: rejectedItemsForArtifact(rejected),
      }),
    );
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
      2,
    );
    await writeOptionalJobsArtifact(
      stagingPath,
      'import-results.json',
      runId,
      importResults,
    );
    await writeJsonArtifact(stagingPath, 'summary.json', summary);
    await rename(stagingPath, runPath);
    return runPath;
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
