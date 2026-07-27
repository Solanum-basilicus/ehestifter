function detailReady(job) {
  return ['ok', 'already_present'].includes(job?.detail?.status);
}

function unavailable(job) {
  return job?.detail?.status === 'error'
    && /job is unavailable/i.test(job.detail.error ?? '');
}

function detailFailure(job) {
  return !detailReady(job) && !unavailable(job);
}

function targetKey(target) {
  return String(target.sequence);
}

export function buildProviderCanaryResults({
  targets,
  providerResults,
  detailResults = [],
  generatedAt = new Date(),
}) {
  const now = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
  if (Number.isNaN(now.getTime())) throw new Error('generatedAt must be a valid date');
  const canaryTargets = targets.filter((target) => target.canary != null);
  const resultBySequence = new Map(
    providerResults.map((result) => [String(result.sequence), result]),
  );
  const detailsBySequence = new Map();
  for (const job of detailResults ?? []) {
    const sequence = job.provenance?.targetSequence;
    if (sequence == null) continue;
    const key = String(sequence);
    if (!detailsBySequence.has(key)) detailsBySequence.set(key, []);
    detailsBySequence.get(key).push(job);
  }

  const canaries = canaryTargets.map((target) => {
    const result = resultBySequence.get(targetKey(target)) ?? null;
    const jobs = detailsBySequence.get(targetKey(target)) ?? [];
    const minimumJobs = target.canary?.minimumJobs ?? 1;
    const minimumDetailSuccesses = target.canary?.minimumDetailSuccesses ?? 0;
    const detailSuccesses = jobs.filter(detailReady).length;
    const detailUnavailable = jobs.filter(unavailable).length;
    const detailFailures = jobs.filter(detailFailure).length;
    const detailErrors = jobs.filter((job) => job.detail?.status === 'error'
      && !unavailable(job)).length;
    const listingHealthy = result?.status === 'ok'
      && result.jobsReturned >= minimumJobs;
    let detailStatus = 'not_required';
    if (minimumDetailSuccesses > 0) {
      if (detailSuccesses >= minimumDetailSuccesses) {
        detailStatus = 'healthy';
      } else if (jobs.length > 0 && detailUnavailable === jobs.length) {
        detailStatus = 'inconclusive';
      } else {
        detailStatus = 'degraded';
      }
    }
    const status = !listingHealthy || detailStatus === 'degraded'
      ? 'degraded'
      : detailStatus === 'inconclusive'
        ? 'inconclusive'
        : 'healthy';
    const warnings = [];
    if (!listingHealthy) {
      warnings.push(
        result?.status === 'error'
          ? `${result.errorClass}: ${result.errorMessage}`
          : `expected at least ${minimumJobs} jobs, received ${result?.jobsReturned ?? 0}`,
      );
    }
    if (detailStatus === 'degraded') {
      warnings.push(
        `expected ${minimumDetailSuccesses} successful detail samples, received ${detailSuccesses}`,
      );
    }
    if (detailStatus === 'inconclusive') {
      warnings.push(
        `all ${detailUnavailable} sampled jobs were unavailable; detail protocol health is inconclusive`,
      );
    }
    return {
      provider: target.provider,
      providerVariant: target.providerVariant ?? null,
      healthPartition: target.healthPartition ?? target.provider,
      tenant: target.tenant,
      name: target.name,
      status,
      listing: {
        status: result?.status ?? 'missing',
        jobsReturned: result?.jobsReturned ?? 0,
        minimumJobs,
        listingOutcome: result?.listingOutcome ?? null,
        acquisitionMode: result?.acquisitionMode ?? null,
        errorClass: result?.errorClass ?? null,
        errorMessage: result?.errorMessage ?? null,
      },
      detail: {
        status: detailStatus,
        sampled: jobs.length,
        minimumSuccesses: minimumDetailSuccesses,
        successes: detailSuccesses,
        unavailable: detailUnavailable,
        failures: detailFailures,
        errors: detailErrors,
      },
      warnings,
    };
  });

  return {
    schemaVersion: 1,
    generatedAtUtc: now.toISOString(),
    canaries,
    jobs: detailResults ?? [],
  };
}
