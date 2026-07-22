function count(items, predicate) {
  return items.filter(predicate).length;
}

function ratio(numerator, denominator) {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

export function buildRunSummary({
  runId,
  mode,
  startedAt,
  finishedAt,
  targetPlan,
  scanResult,
  evaluated,
  tenantStateChanges = null,
  rateObservations = null,
  requestedMaxCreates = null,
}) {
  const providerResults = scanResult.providerResults;
  const attempted = providerResults.filter((result) => result.status !== 'skipped');
  const lookbacks = targetPlan.targets
    .map((target) => target.lookbackStartUtc)
    .filter(Boolean)
    .sort();
  const preflightOk = count(
    evaluated,
    (job) => job.preflight?.status === 'ok',
  );
  const preflightExisting = count(
    evaluated,
    (job) => job.preflight?.status === 'ok' && job.preflight.exists,
  );
  const preflightMissing = count(
    evaluated,
    (job) => job.preflight?.status === 'ok' && !job.preflight.exists,
  );
  const catalogEvaluated = evaluated.filter((job) => job.sourceMode === 'catalog');
  const catalogPreflightOk = count(
    catalogEvaluated,
    (job) => job.preflight?.status === 'ok',
  );
  const catalogPreflightExisting = count(
    catalogEvaluated,
    (job) => job.preflight?.status === 'ok' && job.preflight.exists,
  );
  const catalogPreflightMissing = count(
    catalogEvaluated,
    (job) => job.preflight?.status === 'ok' && !job.preflight.exists,
  );

  return {
    schemaVersion: 3,
    runId,
    mode,
    startedAtUtc: startedAt.toISOString(),
    finishedAtUtc: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),

    targets: targetPlan.targets.length,
    targetsPlanned: targetPlan.targets.length,
    targetsAttempted: attempted.length,
    targetsSkippedByCircuit: count(
      providerResults,
      (result) => result.skipReason === 'provider_circuit_open',
    ),
    targetsSkippedBySchedule: targetPlan.counts.skippedTotal,
    priorityTargets: targetPlan.counts.priority,
    normalTargets: targetPlan.counts.normal,
    liveCatalogRequested: targetPlan.limits?.liveCatalogRequested === true,
    liveCatalogTargets: mode === 'offline' ? 0 : targetPlan.counts.normal,
    catalogTargetsRequested: targetPlan.limits?.catalogTargetsRequested ?? 0,
    disabledTargets: targetPlan.counts.disabled,
    disabledTargetsRemoved: targetPlan.counts.disabledRemoved,
    planningRejected: targetPlan.counts.planningRejected,
    catalogEligibleTargets: targetPlan.counts.catalogEligible,
    skippedNotDue: targetPlan.counts.skippedNotDue,
    skippedProviderCooldown: targetPlan.counts.skippedProviderCooldown,
    skippedNormalBudget: targetPlan.counts.skippedNormalBudget,

    sweepTargetDays: targetPlan.sweep.targetFullSweepDays,
    sweepEstimatedHealthyDays: targetPlan.sweep.estimatedHealthySweepDays,
    sweepRecommendedHealthyTargetsPerRun:
      targetPlan.sweep.recommendedHealthyTargetsPerRun,
    sweepRecommendedTargetsPerRun:
      targetPlan.sweep.recommendedNormalTargetsPerRun,
    sweepFeasibleAtConfiguredBudget:
      targetPlan.sweep.feasibleAtConfiguredBudget,

    providersLoaded: scanResult.providerIds,
    providerSuccesses: count(providerResults, (result) => result.status === 'ok'),
    providerErrors: count(providerResults, (result) => result.status === 'error'),
    providerRateLimited: count(
      providerResults,
      (result) => result.errorClass === 'rate_limited',
    ),
    providerBreakersActivated: scanResult.breakerEvents.length,
    rawJobsReturned: providerResults.reduce(
      (total, result) => total + result.jobsReturned,
      0,
    ),
    candidatesMatchedBeforeCap: providerResults.reduce(
      (total, result) => total
        + (result.candidatesMatched ?? result.candidatesRetained ?? 0),
      0,
    ),
    candidatesDroppedByCap: providerResults.reduce(
      (total, result) => total + (result.candidatesDroppedByCap ?? 0),
      0,
    ),

    catalogAshbyItemCount:
      targetPlan.catalogs.ashby?.acceptedItemCount ?? null,
    catalogAshbySha256:
      targetPlan.catalogs.ashby?.rawSha256 ?? null,
    effectiveLookbackEarliestUtc: lookbacks[0] ?? null,
    effectiveLookbackLatestUtc: lookbacks.at(-1) ?? null,
    unboundedLookbackTargets: count(
      targetPlan.targets,
      (target) => target.lookbackUnbounded === true,
    ),

    tenantStateChanges:
      tenantStateChanges?.tenantChanges.length ?? 0,
    tenantProviderStateChanges:
      tenantStateChanges?.providerChanges.length ?? 0,
    tenantsMarkedActive: count(
      tenantStateChanges?.tenantChanges ?? [],
      (change) => change.health === 'active',
    ),
    tenantsMarkedLongEmpty: count(
      tenantStateChanges?.tenantChanges ?? [],
      (change) => change.health === 'long_empty',
    ),
    tenantsMarkedSuspectedDead: count(
      tenantStateChanges?.tenantChanges ?? [],
      (change) => change.health === 'suspected_dead',
    ),
    tenantsMarkedConfirmedDead: count(
      tenantStateChanges?.tenantChanges ?? [],
      (change) => change.health === 'confirmed_dead',
    ),
    rateRecommendationsDecrease: count(
      rateObservations?.providers ?? [],
      (item) => item.recommendation.action === 'decrease',
    ),
    rateRecommendationsIncrease: count(
      rateObservations?.providers ?? [],
      (item) => item.recommendation.action === 'consider_increase',
    ),

    candidates: scanResult.candidates.length,
    priorityCandidates: count(
      scanResult.candidates,
      (job) => job.sourceMode === 'priority',
    ),
    catalogCandidates: count(
      scanResult.candidates,
      (job) => job.sourceMode === 'catalog',
    ),
    rejected: scanResult.rejected.length + targetPlan.counts.planningRejected,
    locationScopeRejected: count(
      scanResult.rejected,
      (item) => item.reason === 'location_scope_filter',
    ),

    preflightChecked: preflightOk,
    preflightExisting,
    preflightMissing,
    preflightErrors: count(
      evaluated,
      (job) => job.preflight?.status === 'error',
    ),
    preflightExistingRatio: ratio(preflightExisting, preflightOk),
    catalogPreflightChecked: catalogPreflightOk,
    catalogPreflightExisting,
    catalogPreflightMissing,
    catalogPreflightErrors: count(
      catalogEvaluated,
      (job) => job.preflight?.status === 'error',
    ),
    catalogPreflightExistingRatio: ratio(
      catalogPreflightExisting,
      catalogPreflightOk,
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
    detailFetchLimited: count(
      evaluated,
      (job) => job.detail?.status === 'skipped_limit',
    ),
    detailUnsupported: count(
      evaluated,
      (job) => job.detail?.status === 'unsupported_provider',
    ),
    detailErrors: count(evaluated, (job) => job.detail?.status === 'error'),

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

    importCreateLimit: requestedMaxCreates,
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
    importErrors: count(evaluated, (job) => job.import?.status === 'error'),

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
