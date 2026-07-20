function count(items, predicate) {
  return items.filter(predicate).length;
}

export function buildRunSummary({
  runId,
  mode,
  startedAt,
  finishedAt,
  targetPlan,
  scanResult,
  evaluated,
}) {
  const providerResults = scanResult.providerResults;

  return {
    schemaVersion: 1,
    runId,
    mode,
    startedAtUtc: startedAt.toISOString(),
    finishedAtUtc: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),

    // `targets` is retained as a compatibility alias for Phase 1 artifacts.
    targets: targetPlan.targets.length,
    targetsPlanned: targetPlan.targets.length,
    targetsAttempted: providerResults.length,
    priorityTargets: targetPlan.counts.priority,
    normalTargets: targetPlan.counts.normal,
    disabledTargets: targetPlan.counts.disabled,
    disabledTargetsRemoved: targetPlan.counts.disabledRemoved,
    planningRejected: targetPlan.counts.planningRejected,

    providersLoaded: scanResult.providerIds,
    providerSuccesses: count(
      providerResults,
      (result) => result.status === 'ok',
    ),
    providerErrors: count(
      providerResults,
      (result) => result.status === 'error',
    ),
    providerRateLimited: count(
      providerResults,
      (result) => result.errorClass === 'rate_limited',
    ),
    rawJobsReturned: providerResults.reduce(
      (total, result) => total + result.jobsReturned,
      0,
    ),

    catalogAshbyItemCount:
      targetPlan.catalogs.ashby?.acceptedItemCount ?? null,
    catalogAshbySha256:
      targetPlan.catalogs.ashby?.rawSha256 ?? null,

    candidates: scanResult.candidates.length,
    rejected: scanResult.rejected.length + targetPlan.counts.planningRejected,

    preflightExisting: count(
      evaluated,
      (job) => job.preflight?.status === 'ok' && job.preflight.exists,
    ),
    preflightMissing: count(
      evaluated,
      (job) => job.preflight?.status === 'ok' && !job.preflight.exists,
    ),
    preflightErrors: count(
      evaluated,
      (job) => job.preflight?.status === 'error',
    ),

    detailReady: count(evaluated, (job) => job.detail?.status === 'ok'),
    detailAlreadyPresent: count(
      evaluated,
      (job) => job.detail?.status === 'already_present',
    ),
    detailExistingSkipped: count(
      evaluated,
      (job) => job.detail?.status === 'skipped_existing',
    ),
    detailUnsupported: count(
      evaluated,
      (job) => job.detail?.status === 'unsupported_provider',
    ),
    detailErrors: count(
      evaluated,
      (job) => job.detail?.status === 'error',
    ),

    candidateDescriptionsMissing: count(
      evaluated,
      (job) => typeof job.description !== 'string'
        || job.description.trim() === '',
    ),
    missingDescriptionsForImport: count(
      evaluated,
      (job) => job.preflight?.status === 'ok'
        && job.preflight.exists === false
        && (
          typeof job.description !== 'string'
          || job.description.trim() === ''
        ),
    ),

    importExisting: count(
      evaluated,
      (job) => job.import?.status === 'existing_preflight',
    ),
    importSubmitted: count(
      evaluated,
      (job) => job.import?.status === 'submitted',
    ),
    importReconciled: count(
      evaluated,
      (job) => job.import?.status === 'reconciled_after_ambiguous_post',
    ),
    importSkipped: count(
      evaluated,
      (job) => typeof job.import?.status === 'string'
        && job.import.status.startsWith('skipped_'),
    ),
    importErrors: count(
      evaluated,
      (job) => job.import?.status === 'error',
    ),

    locationProviderStructured: count(
      evaluated,
      (job) => job.locationNormalization?.status === 'provider_structured',
    ),
    locationNormalized: count(
      evaluated,
      (job) => [
        'normalized_city_country',
        'normalized_country',
        'normalized_country_scope',
      ].includes(job.locationNormalization?.status),
    ),
    locationUnparsed: count(
      evaluated,
      (job) => typeof job.locationNormalization?.status === 'string'
        && job.locationNormalization.status.startsWith('unparsed_'),
    ),
    locationMissing: count(
      evaluated,
      (job) => job.locationNormalization?.status === 'missing',
    ),
  };
}
