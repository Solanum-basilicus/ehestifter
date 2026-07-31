import { writeRunArtifacts } from './artifacts/run-writer.mjs';
import { buildPrerequisiteFailureSummary } from './run-failure.mjs';
import { buildRunSummary } from './run-summary.mjs';

export async function publishPrerequisiteFailureRun({
  args,
  config,
  runId,
  startedAt,
  planning,
  providers,
  requestedCatalogTargets,
  failure,
}) {
  const finishedAt = new Date();
  planning.plan.discovery = {
    schemaVersion: 1,
    status: 'error',
    eligibleUsers: 0,
    usersWithSavedFilters: 0,
    usersWithValidProfiles: 0,
    usersFailingClosed: 0,
    profileCount: 0,
    sourceGeneratedAtUtc: null,
    portalFiltersMode: config.multiUser.portalFiltersMode,
    error: failure.error.message,
  };
  const scanResult = {
    providerIds: [...providers.keys()].sort(),
    providerResults: [],
    breakerEvents: [],
    candidates: [],
    rejected: [],
  };
  const baseSummary = buildRunSummary({
    runId,
    mode: args.mode,
    startedAt,
    finishedAt,
    targetPlan: planning.plan,
    scanResult,
    evaluated: [],
    tenantStateChanges: null,
    rateObservations: null,
    requestedMaxCreates: args.maxCreate,
    canaryResults: null,
    policy: planning.policy,
    discoveryUsers: null,
    multiUserEnabled: true,
    discoveryUsersError: failure.error.message,
    userMatchResults: null,
    compatibilityResults: null,
    targetsSkippedNoEligibleUsers: 0,
  });
  const summary = buildPrerequisiteFailureSummary(baseSummary, failure);
  const catalogs = planning.plan.catalogs ?? {};
  const runPath = await writeRunArtifacts({
    dataPath: config.paths.data,
    runId,
    metadata: {
      schemaVersion: 3,
      runId,
      mode: args.mode,
      runStatus: failure.outcome,
      failureStage: failure.stage,
      scannerConfigPath: config.configPath,
      careerOpsUpstreamRef: config.careerOps.upstreamRef,
      catalogs: Object.fromEntries(
        Object.entries(catalogs)
          .filter(([, value]) => value != null)
          .map(([provider, value]) => [provider, {
            rawSha256: value.rawSha256,
            acceptedItemCount: value.acceptedItemCount,
          }]),
      ),
      catalogAshbySha256: catalogs.ashby?.rawSha256 ?? null,
      catalogTargetsRequested: requestedCatalogTargets,
      maxCreatesRequested: args.maxCreate,
      multiUserEnabled: true,
      discoveryUsersStatus: 'error',
      eligibleDiscoveryUsers: null,
      portalFiltersMode: config.multiUser.portalFiltersMode,
      compatibilityEnabled: config.multiUser.compatibility.enabled,
      tenantStatePath: null,
      previousTenantStateUpdatedAtUtc:
        planning.tenantState?.updatedAtUtc ?? null,
    },
    failure,
    targetPlan: planning.plan,
    providerResults: [],
    tenantStateChanges: null,
    rateObservations: null,
    canaryResults: null,
    userMatchResults: null,
    compatibilityResults: null,
    candidates: [],
    rejected: planning.planningRejections,
    preflightResults: null,
    detailResults: null,
    locationResults: null,
    importResults: null,
    summary,
  });
  return { runPath, tenantStatePath: null, summary };
}
