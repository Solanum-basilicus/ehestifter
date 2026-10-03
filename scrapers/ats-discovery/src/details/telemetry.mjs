function providerFor(job) {
  return job?.detail?.provider
    ?? job?.sourceProvider
    ?? job?.canonicalIdentity?.provider
    ?? 'unknown';
}

function emptyStats(provider) {
  return {
    provider,
    candidates: 0,
    attempts: 0,
    rateLimitedResponses: 0,
    retriedCandidates: 0,
    ok: 0,
    alreadyPresent: 0,
    missingDescription: 0,
    unavailable: 0,
    errors: 0,
    unsupported: 0,
    skippedExisting: 0,
    skippedLimit: 0,
    skippedPreflightError: 0,
  };
}

function accumulate(target, jobs) {
  for (const job of jobs ?? []) {
    const detail = job?.detail;
    if (!detail || typeof detail !== 'object') continue;
    const provider = providerFor(job);
    if (!target.has(provider)) target.set(provider, emptyStats(provider));
    const stats = target.get(provider);
    stats.candidates += 1;
    stats.attempts += Number.isInteger(detail.attempts) ? detail.attempts : 0;
    stats.rateLimitedResponses += Number.isInteger(detail.rateLimitedResponses)
      ? detail.rateLimitedResponses
      : 0;
    if ((detail.attempts ?? 0) > 1) stats.retriedCandidates += 1;
    if (detail.status === 'ok') stats.ok += 1;
    else if (detail.status === 'already_present') stats.alreadyPresent += 1;
    else if (detail.status === 'missing_description') stats.missingDescription += 1;
    else if (detail.status === 'unavailable') stats.unavailable += 1;
    else if (detail.status === 'error') stats.errors += 1;
    else if (detail.status === 'unsupported_provider') stats.unsupported += 1;
    else if (detail.status === 'skipped_existing') stats.skippedExisting += 1;
    else if (detail.status === 'skipped_limit') stats.skippedLimit += 1;
    else if (detail.status === 'skipped_preflight_error') stats.skippedPreflightError += 1;
  }
}

function sortedStats(map) {
  return [...map.values()].sort((left, right) => left.provider.localeCompare(right.provider));
}

export function buildDetailTelemetry({ candidateResults = [], canaryResults = [] } = {}) {
  const combined = new Map();
  const candidate = new Map();
  const canary = new Map();
  accumulate(candidate, candidateResults);
  accumulate(canary, canaryResults);
  accumulate(combined, candidateResults);
  accumulate(combined, canaryResults);
  const providers = sortedStats(combined);
  return {
    schemaVersion: 1,
    totals: {
      candidates: providers.reduce((sum, item) => sum + item.candidates, 0),
      attempts: providers.reduce((sum, item) => sum + item.attempts, 0),
      rateLimitedResponses: providers.reduce((sum, item) => sum + item.rateLimitedResponses, 0),
      errors: providers.reduce((sum, item) => sum + item.errors, 0),
    },
    providers,
    phases: {
      candidates: sortedStats(candidate),
      canaries: sortedStats(canary),
    },
  };
}
