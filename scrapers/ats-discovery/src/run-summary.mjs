import { getProviderPolicy } from './policy/discovery-policy.mjs';
import { isDurableProviderResult, isTransientProviderResult } from './scan/provider-errors.mjs';

function count(items, predicate) {
  return items.filter(predicate).length;
}

function ratio(numerator, denominator) {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

function providerVariantHealth({
  providerResults,
  breakerEvents,
  tenantStateChanges,
  canaryResults,
  plannedHealthPartitions,
  policy,
}) {
  const partitionPlans = plannedHealthPartitions ?? {};
  const groups = new Map(
    Object.keys(partitionPlans).map((healthPartition) => [healthPartition, []]),
  );
  for (const result of providerResults) {
    const key = result.healthPartition ?? result.provider ?? 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(result);
  }
  const breakerByPartition = new Map(
    breakerEvents.map((event) => [event.healthPartition ?? event.provider, event]),
  );
  const emptyAnomalyByPartition = new Map();
  const volumeAnomalyByPartition = new Map();
  for (const change of tenantStateChanges?.tenantChanges ?? []) {
    const key = change.healthPartition ?? change.provider ?? 'unknown';
    if (change.listingOutcome === 'listing_empty_anomaly') {
      emptyAnomalyByPartition.set(
        key,
        (emptyAnomalyByPartition.get(key) ?? 0) + 1,
      );
    }
    if (change.listingOutcome === 'listing_volume_anomaly') {
      volumeAnomalyByPartition.set(
        key,
        (volumeAnomalyByPartition.get(key) ?? 0) + 1,
      );
    }
  }
  const canaryByPartition = new Map();
  for (const canary of canaryResults?.canaries ?? []) {
    const key = canary.healthPartition ?? canary.provider ?? 'unknown';
    if (!canaryByPartition.has(key)) canaryByPartition.set(key, []);
    canaryByPartition.get(key).push(canary);
  }

  const variants = {};
  const warnings = [];
  const notices = [];
  for (const [healthPartition, results] of [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))) {
    const planStats = partitionPlans[healthPartition] ?? null;
    const provider = results[0]?.provider
      ?? planStats?.provider
      ?? healthPartition.split(':')[0]
      ?? 'unknown';
    const providerVariant = results[0]?.providerVariant
      ?? planStats?.providerVariant
      ?? null;
    const attempted = results.filter((item) => item.status !== 'skipped');
    const errors = attempted.filter((item) => item.status === 'error').length;
    const healthErrors = attempted.filter(isTransientProviderResult).length;
    const durableTenantFailures = attempted.filter(isDurableProviderResult).length;
    const monitoring = policy
      ? getProviderPolicy(policy, provider).monitoring
      : { degradedMinimumAttempts: 2, degradedErrorRatio: 0.5 };
    const healthErrorRatio = attempted.length === 0
      ? 0
      : healthErrors / attempted.length;
    const breaker = breakerByPartition.get(healthPartition) ?? null;
    const listingEmptyAnomalies =
      emptyAnomalyByPartition.get(healthPartition) ?? 0;
    const listingVolumeAnomalies =
      volumeAnomalyByPartition.get(healthPartition) ?? 0;
    const listingAnomalies = listingEmptyAnomalies + listingVolumeAnomalies;
    const canaries = canaryByPartition.get(healthPartition) ?? [];
    const degradedCanaries = canaries.filter((item) => item.status === 'degraded');
    const inconclusiveCanaries = canaries.filter(
      (item) => item.status === 'inconclusive',
    );
    const listingOutcomes = {};
    for (const result of results) {
      const outcome = result.listingOutcome ?? 'unknown';
      listingOutcomes[outcome] = (listingOutcomes[outcome] ?? 0) + 1;
    }
    const skippedProviderCooldown = planStats?.skippedProviderCooldown ?? 0;
    const skippedNotDue = planStats?.skippedNotDue ?? 0;
    const skippedNormalBudget = planStats?.skippedNormalBudget ?? 0;
    const degraded = Boolean(breaker)
      || skippedProviderCooldown > 0
      || listingAnomalies > 0
      || degradedCanaries.length > 0
      || (
        attempted.length >= monitoring.degradedMinimumAttempts
        && healthErrorRatio >= monitoring.degradedErrorRatio
      );
    const itemWarnings = [];
    const itemNotices = [];
    if (breaker) itemWarnings.push(`circuit open: ${breaker.reason}`);
    if (skippedProviderCooldown > 0) {
      itemWarnings.push(`${skippedProviderCooldown} target(s) skipped because this health partition is in cooldown`);
    }
    if (listingEmptyAnomalies > 0) {
      itemWarnings.push(`${listingEmptyAnomalies} historical nonempty tenant(s) returned explicit zero and were scheduled for re-probe`);
    }
    if (listingVolumeAnomalies > 0) {
      itemWarnings.push(`${listingVolumeAnomalies} tenant(s) had suspicious listing volume drops or canary threshold misses and were scheduled for re-probe`);
    }
    if (degradedCanaries.length > 0) {
      itemWarnings.push(`${degradedCanaries.length}/${canaries.length} provider canary target(s) degraded`);
    }
    if (inconclusiveCanaries.length > 0) {
      itemNotices.push(`${inconclusiveCanaries.length}/${canaries.length} provider canary target(s) had inconclusive detail samples`);
    }
    if (
      attempted.length >= monitoring.degradedMinimumAttempts
      && healthErrorRatio >= monitoring.degradedErrorRatio
    ) {
      itemWarnings.push(`${healthErrors}/${attempted.length} attempted targets had health-significant failures`);
    }
    variants[healthPartition] = {
      provider,
      providerVariant,
      healthPartition,
      status: degraded ? 'degraded' : 'healthy',
      targetsPlanned: planStats?.selectedTargets ?? results.length,
      targetsAttempted: attempted.length,
      targetsSkippedBySchedule:
        skippedNotDue + skippedProviderCooldown + skippedNormalBudget,
      skippedNotDue,
      skippedProviderCooldown,
      skippedNormalBudget,
      successes: attempted.filter((item) => item.status === 'ok').length,
      errors,
      healthErrors,
      durableTenantFailures,
      healthErrorRatio: Math.round(healthErrorRatio * 10_000) / 10_000,
      skippedByCircuit: results.filter(
        (item) => item.skipReason === 'provider_circuit_open',
      ).length,
      jobsReturned: results.reduce((sum, item) => sum + item.jobsReturned, 0),
      listingOutcomes,
      listingEmptyAnomalies,
      listingVolumeAnomalies,
      listingAnomalies,
      breakerOpen: Boolean(breaker),
      breakerReason: breaker?.reason ?? null,
      canaries: {
        total: canaries.length,
        healthy: canaries.filter((item) => item.status === 'healthy').length,
        degraded: degradedCanaries.length,
        inconclusive: inconclusiveCanaries.length,
      },
      warnings: itemWarnings,
      notices: itemNotices,
    };
    for (const warning of itemWarnings) {
      warnings.push(`DEGRADED ${healthPartition}: ${warning}`);
    }
    for (const notice of itemNotices) {
      notices.push(`NOTICE ${healthPartition}: ${notice}`);
    }
  }
  return { variants, warnings, notices };
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
  canaryResults = null,
  policy,
  discoveryUsers = null,
  multiUserEnabled = discoveryUsers != null,
  discoveryUsersError = null,
  userMatchResults = null,
  compatibilityResults = null,
  targetsSkippedNoEligibleUsers = 0,
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
  const providerHealth = providerVariantHealth({
    providerResults,
    breakerEvents: scanResult.breakerEvents,
    tenantStateChanges,
    canaryResults,
    plannedHealthPartitions: targetPlan.healthPartitions,
    policy,
  });
  const catalogProviders = ['ashby', 'greenhouse', 'lever', 'workday'];
  const catalogMetrics = Object.fromEntries(catalogProviders.map((provider) => {
    const metadata = targetPlan.catalogs?.[provider] ?? null;
    const providerEvaluated = catalogEvaluated.filter(
      (job) => job.sourceProvider === provider,
    );
    const providerPreflightOk = count(
      providerEvaluated,
      (job) => job.preflight?.status === 'ok',
    );
    const providerExisting = count(
      providerEvaluated,
      (job) => job.preflight?.status === 'ok' && job.preflight.exists,
    );
    return [provider, {
      itemCount: metadata?.acceptedItemCount ?? null,
      rawSha256: metadata?.rawSha256 ?? null,
      eligibleTargets: metadata?.eligibleItemCount ?? 0,
      dueTargets: metadata?.dueItemCount ?? 0,
      plannedTargets: metadata?.plannedTargetCount ?? 0,
      candidates: count(
        scanResult.candidates,
        (job) => job.sourceMode === 'catalog' && job.sourceProvider === provider,
      ),
      preflightChecked: providerPreflightOk,
      preflightExisting: providerExisting,
      preflightMissing: providerPreflightOk - providerExisting,
      preflightErrors: count(
        providerEvaluated,
        (job) => job.preflight?.status === 'error',
      ),
      preflightExistingRatio: ratio(providerExisting, providerPreflightOk),
      sweep: targetPlan.catalogSweeps?.[provider] ?? null,
    }];
  }));

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
    targetsSkippedNoEligibleUsers,
    priorityTargets: targetPlan.counts.priority,
    canaryTargets: targetPlan.counts.canary ?? 0,
    normalTargets: targetPlan.counts.normal,
    liveCatalogRequested: targetPlan.limits?.liveCatalogRequested === true,
    liveCatalogTargets: mode === 'offline' ? 0 : targetPlan.counts.normal,
    catalogTargetsRequested: targetPlan.limits?.catalogTargetsRequested ?? 0,
    disabledTargets: targetPlan.counts.disabled,
    disabledTargetsRemoved: targetPlan.counts.disabledRemoved,
    planningRejected: targetPlan.counts.planningRejected,
    canaryPlanningRejected: targetPlan.counts.canaryPlanningRejected ?? 0,
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
    providerVariants: providerHealth.variants,
    providerHealthWarnings: providerHealth.warnings,
    providerHealthNotices: providerHealth.notices,
    providerCanaries: canaryResults?.canaries.length ?? 0,
    providerCanariesHealthy: count(
      canaryResults?.canaries ?? [],
      (item) => item.status === 'healthy',
    ),
    providerCanariesDegraded: count(
      canaryResults?.canaries ?? [],
      (item) => item.status === 'degraded',
    ),
    providerCanariesInconclusive: count(
      canaryResults?.canaries ?? [],
      (item) => item.status === 'inconclusive',
    ),
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

    catalogs: catalogMetrics,
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
    tenantsScheduledForEmptyReprobe: count(
      tenantStateChanges?.tenantChanges ?? [],
      (change) => change.listingOutcome === 'listing_empty_anomaly',
    ),
    tenantsScheduledForListingReprobe: count(
      tenantStateChanges?.tenantChanges ?? [],
      (change) => [
        'listing_empty_anomaly',
        'listing_volume_anomaly',
      ].includes(change.listingOutcome),
    ),
    rateRecommendationsDecrease: count(
      rateObservations?.providers ?? [],
      (item) => item.recommendation.action === 'decrease',
    ),
    rateRecommendationsIncrease: count(
      rateObservations?.providers ?? [],
      (item) => item.recommendation.action === 'consider_increase',
    ),

    multiUserEnabled,
    discoveryUsersLoadStatus: !multiUserEnabled
      ? 'disabled'
      : discoveryUsersError == null ? 'ok' : 'error',
    discoveryUsersLoadError: discoveryUsersError,
    discoveryUsersEligible: multiUserEnabled
      ? discoveryUsers?.length ?? 0
      : null,
    discoveryUsersWithSavedFilters: multiUserEnabled
      ? count(discoveryUsers ?? [], (user) => user.hasSavedFilters)
      : null,
    discoveryUsersWithValidProfiles: multiUserEnabled
      ? count(discoveryUsers ?? [], (user) => user.profiles.length > 0)
      : null,
    discoveryUsersFailingClosed: multiUserEnabled
      ? count(
        discoveryUsers ?? [],
        (user) => user.hasSavedFilters && user.profiles.length === 0,
      )
      : null,
    candidatesRejectedNoUserMatch: count(
      scanResult.rejected,
      (item) => item.reason === 'no_user_match',
    ),
    userCandidateMatches: scanResult.candidates.reduce(
      (total, job) => total + (job.matchedUserIds?.length ?? 0),
      0,
    ),
    userMatchArtifactCandidates: userMatchResults?.matches.length ?? 0,

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

    compatibilityPairs: compatibilityResults?.totalPairs ?? 0,
    compatibilityEvaluated: compatibilityResults?.evaluatedPairs ?? 0,
    compatibilityOmittedByPairLimit: compatibilityResults?.omittedPairs ?? 0,
    compatibilityRequested: count(
      compatibilityResults?.results ?? [],
      (item) => item.status === 'requested',
    ),
    compatibilityAlreadyActive: count(
      compatibilityResults?.results ?? [],
      (item) => item.status === 'skipped_active',
    ),
    compatibilityAlreadySucceeded: count(
      compatibilityResults?.results ?? [],
      (item) => [
        'skipped_succeeded_current_cv',
        'skipped_succeeded_unknown_cv',
      ].includes(item.status),
    ),
    compatibilitySkippedRequestLimit: count(
      compatibilityResults?.results ?? [],
      (item) => item.status === 'skipped_request_limit',
    ),
    compatibilityErrors: count(
      compatibilityResults?.results ?? [],
      (item) => item.status === 'error_latest_check'
        || item.status === 'error_request',
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
        'normalized_multiple',
      ].includes(job.locationNormalization?.status),
    ),
    locationEligible: count(
      evaluated,
      (job) => job.locationEligibility?.status === 'eligible',
    ),
    locationIneligible: count(
      evaluated,
      (job) => job.locationEligibility?.status === 'ineligible',
    ),
    locationUnclear: count(
      evaluated,
      (job) => job.locationEligibility?.status === 'unclear',
    ),
    locationConflicting: count(
      evaluated,
      (job) => job.locationNormalization?.consistency === 'conflicting',
    ),
    locationUnresolvedObservations: evaluated.reduce(
      (total, job) => total
        + (job.locationNormalization?.unresolved?.length ?? 0),
      0,
    ),
    importSkippedLocationIneligible: count(
      evaluated,
      (job) => job.import?.status === 'skipped_location_ineligible',
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
