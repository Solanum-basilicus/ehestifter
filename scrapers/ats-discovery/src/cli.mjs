#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createRunId,
  writeRunArtifacts,
  writeRunFailureArtifact,
} from './artifacts/run-writer.mjs';
import {
  catalogSyncSummary,
  syncAllProviderCatalogs,
  syncProviderCatalog,
} from './catalogs/sync-provider-catalog.mjs';
import { parseArgs, usageText } from './cli-args.mjs';
import {
  loadRuntimeConfig,
  validateLiveCatalogTargetRequest,
} from './config.mjs';
import { enrichCandidateDetails } from './details/fetchers.mjs';
import { createEnrichmentClient } from './ehestifter/enrichment-client.mjs';
import { importCandidates } from './ehestifter/import-jobs.mjs';
import { createJobsClient, preflightCandidates } from './ehestifter/jobs-client.mjs';
import { repairLeverDescription } from './maintenance/repair-lever-description.mjs';
import { requestCompatibilityForMatches } from './ehestifter/request-compatibility.mjs';
import { createUsersClient } from './ehestifter/users-client.mjs';
import { normalizeCandidateLocations } from './locations/normalizer.mjs';
import { loadProviders } from './providers/_registry.mjs';
import { makeHttpCtx } from './providers/_http.mjs';
import { publishPrerequisiteFailureRun } from './prerequisite-failure-run.mjs';
import {
  classifyPrerequisiteFailure,
  classifyRuntimeFailure,
} from './run-failure.mjs';
import { buildRunSummary } from './run-summary.mjs';
import { buildProviderCanaryResults } from './scan/provider-canaries.mjs';
import { buildRateObservations } from './scan/rate-observations.mjs';
import { runTrackedScan } from './scan/tracked-source.mjs';
import {
  buildNextTenantState,
  saveTenantState,
} from './state/tenant-state.mjs';
import { buildTargetPlanFromFiles } from './targets/planner.mjs';
import { createProgressRenderer } from './ui/progress.mjs';
import {
  buildDiscoveryMatcher,
  buildUserMatchArtifact,
  selectDiscoveryExecutionTargets,
} from './users/discovery-matcher.mjs';

function assertCatalogTargetSafety(mode, runtimeTargets, requestedLimit) {
  const normalTargets = runtimeTargets.filter(
    (target) => target.targetClass === 'normal',
  );
  if (mode === 'offline') return;
  if (requestedLimit === 0 && normalTargets.length > 0) {
    throw new Error(
      'Safety invariant violated: live catalog targets require '
      + '--catalog-targets N',
    );
  }
  if (normalTargets.length > requestedLimit) {
    throw new Error(
      `Safety invariant violated: planned ${normalTargets.length} catalog `
      + `targets exceeds requested ${requestedLimit}`,
    );
  }
}

function progressDetail(event) {
  return [event.provider, event.tenant]
    .filter(Boolean)
    .join(':');
}

async function runCatalogSync(provider) {
  const config = await loadRuntimeConfig({ operation: 'catalog-sync' });
  if (provider === 'all') {
    const catalogs = await syncAllProviderCatalogs({
      outputPaths: config.catalogs.paths,
    });
    console.log(JSON.stringify({
      outputPaths: config.catalogs.paths,
      summaries: catalogs.map(catalogSyncSummary),
    }, null, 2));
    return;
  }
  const catalog = await syncProviderCatalog(provider, {
    outputPath: config.catalogs.paths[provider],
  });
  console.log(JSON.stringify({
    outputPath: config.catalogs.paths[provider],
    summary: catalogSyncSummary(catalog),
  }, null, 2));
}

async function runLeverDescriptionRepair(args) {
  const config = await loadRuntimeConfig({
    operation: 'maintenance',
    mode: 'maintenance',
  });
  const jobsClient = createJobsClient(config.jobsApi);
  const http = makeHttpCtx({
    timeoutMs: config.scan.description.timeoutMs,
    maxResponseBytes: 5_000_000,
  });
  const result = await repairLeverDescription({
    postingUrl: args.postingUrl,
    apply: args.apply,
    jobsClient,
    fetchJson: http.fetchJson,
  });
  console.log(JSON.stringify(result, null, 2));
}

async function runScan(args) {
  const progress = createProgressRenderer({
    enabled: args.noProgress ? false : 'auto',
  });
  let progressCleared = false;
  const startedAt = new Date();
  const runId = createRunId(startedAt);
  let config = null;
  let requestedCatalogTargets = args.catalogTargets ?? 0;
  let providers = null;
  let planning = null;
  let scanResult = null;
  let userMatchResults = null;
  let canaryResults = null;
  let preflightResults = null;
  let detailResults = null;
  let locationResults = null;
  let importResults = null;
  let compatibilityResults = null;
  let rateObservations = null;
  let tenantStateChanges = null;
  let summary = null;
  let rejected = null;
  let runPublished = false;
  let publishedRunPath = null;
  let failureStage = 'runtime_config_load';
  let prerequisiteFailure = false;

  try {
    config = await loadRuntimeConfig({
      operation: 'scan',
      mode: args.mode,
    });
    failureStage = 'runtime_config_validation';
    requestedCatalogTargets = validateLiveCatalogTargetRequest({
      mode: args.mode,
      requested: args.catalogTargets,
      liveCatalog: config.liveCatalog,
    });
    if (
      args.mode === 'import'
      && args.maxCreate > config.imports.maxCreatesPerRun
    ) {
      prerequisiteFailure = true;
      throw new Error(
        `--max-create ${args.maxCreate} exceeds imports.maxCreatesPerRun `
        + `${config.imports.maxCreatesPerRun}`,
      );
    }
    prerequisiteFailure = false;

    let discoveryUsersPayload = null;
    let discoveryMatcher = null;
    let discoveryUsersError = null;

    failureStage = 'provider_load';
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const providersDir = path.join(moduleDir, 'providers');
    providers = await loadProviders(providersDir);
    if (providers.size === 0) {
      throw new Error(`No providers loaded from ${providersDir}`);
    }

    failureStage = 'target_planning';
    planning = await buildTargetPlanFromFiles({
      portalsPath: config.paths.portals,
      companyOverridesPath: config.paths.companyOverrides,
      discoveryPolicyPath: config.paths.discoveryPolicy,
      catalogPaths: config.catalogs.paths,
      tenantStatePath: config.state.tenantStatePath,
      providers,
      mode: args.mode,
      generatedAt: startedAt,
      catalogTargetLimit: requestedCatalogTargets,
    });
    assertCatalogTargetSafety(
      args.mode,
      planning.runtimeTargets,
      requestedCatalogTargets,
    );

    if (config.multiUser.enabled) {
      failureStage = 'discovery_users_load';
      progress.update({ stage: 'users', current: 0, total: 1 });
      try {
        const usersClient = createUsersClient(config.usersApi);
        discoveryUsersPayload = await usersClient.listDiscoveryEligible();
        discoveryMatcher = buildDiscoveryMatcher(discoveryUsersPayload);
      } catch (error) {
        progress.update({ stage: 'users', current: 1, total: 1 });
        const failure = classifyPrerequisiteFailure(error);
        const published = await publishPrerequisiteFailureRun({
          args,
          config,
          runId,
          startedAt,
          planning,
          providers,
          requestedCatalogTargets,
          failure,
        });
        progress.clear();
        progressCleared = true;
        console.log(JSON.stringify(published, null, 2));
        process.exitCode = failure.exitCode;
        return;
      }
      progress.update({ stage: 'users', current: 1, total: 1 });
    }

    if (discoveryMatcher) {
      planning.plan.discovery = {
        ...discoveryMatcher.compoundedProfile,
        status: 'ok',
        sourceGeneratedAtUtc: discoveryMatcher.sourceGeneratedAtUtc,
        portalFiltersMode: config.multiUser.portalFiltersMode,
      };
    } else if (config.multiUser.enabled) {
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
        error: discoveryUsersError,
      };
    }

    const discoveryExecution = selectDiscoveryExecutionTargets({
      runtimeTargets: planning.runtimeTargets,
      multiUserEnabled: config.multiUser.enabled,
      discoveryUsers: discoveryMatcher?.users ?? [],
    });
    const { executionTargets, targetsSkippedNoEligibleUsers } = discoveryExecution;

    progress.update({
      stage: 'scan',
      current: 0,
      total: executionTargets.length,
    });
    failureStage = 'provider_scan';
    scanResult = await runTrackedScan({
      portalConfig: planning.portalConfig,
      targets: executionTargets,
      providers,
      policy: planning.policy,
      concurrency: config.scan.providerConcurrency,
      maxCandidates: config.scan.maxCandidatesPerRun,
      upstreamRef: config.careerOps.upstreamRef,
      candidateMatcher: discoveryMatcher?.matchCandidate ?? null,
      applyPortalCandidateFilters: !config.multiUser.enabled
        || config.multiUser.portalFiltersMode === 'global_gate',
      onProgress: (event) => progress.update({
        ...event,
        detail: progressDetail(event),
      }),
    });

    failureStage = 'user_match_artifact';
    userMatchResults = discoveryMatcher
      ? buildUserMatchArtifact({
        discoveryMatcher,
        candidates: scanResult.candidates,
        rejected: scanResult.rejected,
      })
      : null;

    let canaryDetailResults = null;
    if (scanResult.canaryCandidates.length > 0) {
      failureStage = 'provider_canary_details';
      progress.update({
        stage: 'details',
        current: 0,
        total: scanResult.canaryCandidates.length,
        detail: 'provider canaries',
      });
      canaryDetailResults = await enrichCandidateDetails(
        scanResult.canaryCandidates,
        {
          concurrency: config.scan.description.concurrency,
          maxFetches: scanResult.canaryCandidates.length,
          timeoutMs: config.scan.description.timeoutMs,
          onProgress: (event) => progress.update({
            ...event,
            detail: 'provider canaries',
          }),
        },
      );
    }
    failureStage = 'provider_canary_evaluation';
    const hasCanaryTargets = planning.runtimeTargets.some(
      (target) => target.canary != null,
    );
    canaryResults = hasCanaryTargets
      ? buildProviderCanaryResults({
        targets: executionTargets,
        providerResults: scanResult.providerResults,
        detailResults: canaryDetailResults ?? [],
        generatedAt: new Date(),
      })
      : null;

    let client = null;
    if (args.mode === 'preflight' || args.mode === 'import') {
      failureStage = 'preflight';
      client = createJobsClient(config.jobsApi);
      progress.update({
        stage: 'preflight',
        current: 0,
        total: scanResult.candidates.length,
      });
      preflightResults = await preflightCandidates(
        scanResult.candidates,
        client,
        config.scan.jobsApiConcurrency,
        {
          onProgress: (event) => progress.update(event),
        },
      );
    }

    if (
      (args.mode === 'preflight' || args.mode === 'import')
      && config.scan.description.fetchMissing
    ) {
      failureStage = 'detail_enrichment';
      const eligibleDetails = preflightResults.filter((candidate) => (
        candidate.preflight?.status === 'ok'
        && !candidate.preflight.exists
        && (
          typeof candidate.description !== 'string'
          || candidate.description.trim() === ''
        )
      )).length;
      const detailTotal = Math.min(
        eligibleDetails,
        config.scan.description.maxFetchesPerRun,
      );
      progress.update({
        stage: 'details',
        current: 0,
        total: detailTotal,
      });
      detailResults = await enrichCandidateDetails(preflightResults, {
        concurrency: config.scan.description.concurrency,
        maxFetches: config.scan.description.maxFetchesPerRun,
        timeoutMs: config.scan.description.timeoutMs,
        onProgress: (event) => progress.update(event),
      });
    }

    if (args.mode === 'preflight' || args.mode === 'import') {
      failureStage = 'location_normalization';
      locationResults = normalizeCandidateLocations(
        detailResults ?? preflightResults,
        {
          locationScopeFilter: planning.portalConfig.location_scope_filter,
        },
      );
    }

    if (args.mode === 'import') {
      failureStage = 'import';
      progress.update({
        stage: 'import',
        current: 0,
        total: locationResults.length,
      });
      importResults = await importCandidates(locationResults, client, {
        maxCreates: args.maxCreate,
        requireDescription: config.scan.requireDescriptionForCreate,
        onProgress: (event) => progress.update(event),
      });
    }

    if (
      args.mode === 'import'
      && config.multiUser.enabled
      && config.multiUser.compatibility.enabled
      && discoveryMatcher != null
    ) {
      failureStage = 'compatibility';
      const enrichmentClient = createEnrichmentClient(config.enrichmentApi);
      progress.update({
        stage: 'compatibility',
        current: 0,
        total: Math.min(
          config.multiUser.compatibility.maxPairsPerRun,
          importResults.reduce(
            (total, candidate) => total + (candidate.matchedUserIds?.length ?? 0),
            0,
          ),
        ),
      });
      compatibilityResults = await requestCompatibilityForMatches({
        importResults,
        discoveryUsers: discoveryMatcher.users,
        client: enrichmentClient,
        config: config.multiUser.compatibility,
        onProgress: (event) => progress.update(event),
      });
    }

    const evaluated = importResults
      ?? locationResults
      ?? detailResults
      ?? preflightResults
      ?? scanResult.candidates;
    const finishedAt = new Date();

    failureStage = 'rate_observations';
    rateObservations = buildRateObservations({
      providerResults: scanResult.providerResults,
      breakerEvents: scanResult.breakerEvents,
      policy: planning.policy,
      targetPlan: planning.plan,
      generatedAt: finishedAt,
    });

    const shouldPersistTenantState = (
      args.mode === 'offline' || planning.plan.counts.normal > 0
    ) && (
      !config.multiUser.enabled || executionTargets.length > 0
    );
    let nextTenantState = null;
    if (shouldPersistTenantState) {
      failureStage = 'tenant_state_transition';
      const transition = buildNextTenantState({
        previousState: planning.tenantState,
        targets: planning.runtimeTargets,
        providerResults: scanResult.providerResults,
        rateObservations,
        breakerEvents: scanResult.breakerEvents,
        policy: planning.policy,
        finishedAt,
      });
      nextTenantState = transition.state;
      tenantStateChanges = transition.changes;
    }

    failureStage = 'summary_build';
    summary = buildRunSummary({
      runId,
      mode: args.mode,
      startedAt,
      finishedAt,
      targetPlan: planning.plan,
      scanResult,
      evaluated,
      tenantStateChanges,
      rateObservations,
      requestedMaxCreates: args.maxCreate,
      canaryResults,
      policy: planning.policy,
      discoveryUsers: discoveryMatcher?.users ?? null,
      multiUserEnabled: config.multiUser.enabled,
      discoveryUsersError,
      userMatchResults,
      compatibilityResults,
      targetsSkippedNoEligibleUsers,
    });

    rejected = [
      ...planning.planningRejections,
      ...scanResult.rejected,
    ];
    failureStage = 'artifact_publish';
    const runPath = await writeRunArtifacts({
      dataPath: config.paths.data,
      runId,
      metadata: {
        schemaVersion: 3,
        runId,
        mode: args.mode,
        scannerConfigPath: config.configPath,
        careerOpsUpstreamRef: config.careerOps.upstreamRef,
        catalogs: Object.fromEntries(
          Object.entries(planning.plan.catalogs)
            .filter(([, value]) => value != null)
            .map(([provider, value]) => [provider, {
              rawSha256: value.rawSha256,
              acceptedItemCount: value.acceptedItemCount,
            }]),
        ),
        // Compatibility breadcrumb retained while Phase 5B rolls out.
        catalogAshbySha256: planning.plan.catalogs.ashby?.rawSha256 ?? null,
        catalogTargetsRequested: requestedCatalogTargets,
        maxCreatesRequested: args.maxCreate,
        multiUserEnabled: config.multiUser.enabled,
        discoveryUsersStatus: !config.multiUser.enabled
          ? 'disabled'
          : discoveryUsersError == null ? 'ok' : 'error',
        eligibleDiscoveryUsers: discoveryMatcher?.users.length ?? null,
        portalFiltersMode: config.multiUser.enabled
          ? config.multiUser.portalFiltersMode
          : null,
        compatibilityEnabled: config.multiUser.enabled
          && config.multiUser.compatibility.enabled,
        tenantStatePath: shouldPersistTenantState
          ? config.state.tenantStatePath
          : null,
        previousTenantStateUpdatedAtUtc:
          planning.tenantState.updatedAtUtc,
      },
      targetPlan: planning.plan,
      providerResults: scanResult.providerResults,
      tenantStateChanges,
      rateObservations,
      canaryResults,
      userMatchResults,
      compatibilityResults,
      candidates: scanResult.candidates,
      rejected,
      preflightResults,
      detailResults,
      locationResults,
      importResults,
      summary,
    });
    runPublished = true;
    publishedRunPath = runPath;

    if (nextTenantState) {
      failureStage = 'tenant_state_persist';
      try {
        await saveTenantState(config.state.tenantStatePath, nextTenantState);
      } catch (error) {
        throw new Error(
          `Run artifacts were published at ${runPath}, but tenant state `
          + `could not be persisted to ${config.state.tenantStatePath}`,
          { cause: error },
        );
      }
    }

    progress.clear();
    progressCleared = true;
    console.log(JSON.stringify({
      runPath,
      tenantStatePath: nextTenantState ? config.state.tenantStatePath : null,
      summary,
    }, null, 2));
    if (
      summary.preflightErrors > 0
      || summary.importErrors > 0
      || summary.canaryPlanningRejected > 0
      || summary.providerCanariesDegraded > 0
      || summary.providerHealthWarnings.length > 0
      || summary.discoveryUsersLoadStatus === 'error'
      || summary.compatibilityErrors > 0
    ) {
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    const failure = prerequisiteFailure
      ? classifyPrerequisiteFailure(error, failureStage)
      : classifyRuntimeFailure(error, failureStage);
    if (config && runPublished && publishedRunPath) {
      try {
        await writeRunFailureArtifact(publishedRunPath, failure);
        progress.clear();
        progressCleared = true;
        console.log(JSON.stringify({
          runPath: publishedRunPath,
          tenantStatePath: null,
          failure,
        }, null, 2));
        process.exitCode = failure.exitCode;
        return;
      } catch (publishError) {
        console.error(
          `Failed to attach failure evidence to run ${runId}: ${publishError instanceof Error ? publishError.stack : String(publishError)}`,
        );
      }
    } else if (config) {
      try {
        const runPath = await writeRunArtifacts({
          dataPath: config.paths.data,
          runId,
          metadata: {
            schemaVersion: 3,
            runId,
            mode: args.mode,
            runStatus: failure.outcome,
            failureStage: failure.stage,
            partial: true,
            scannerConfigPath: config.configPath,
            careerOpsUpstreamRef: config.careerOps.upstreamRef,
            catalogTargetsRequested: requestedCatalogTargets,
            maxCreatesRequested: args.maxCreate,
          },
          failure,
          targetPlan: planning?.plan ?? null,
          providerResults: scanResult?.providerResults ?? null,
          tenantStateChanges,
          rateObservations,
          canaryResults,
          userMatchResults,
          compatibilityResults,
          candidates: scanResult?.candidates ?? null,
          rejected: rejected ?? (scanResult
            ? [...(planning?.planningRejections ?? []), ...scanResult.rejected]
            : planning?.planningRejections ?? null),
          preflightResults,
          detailResults,
          locationResults,
          importResults,
          summary: summary ? {
            ...summary,
            runStatus: failure.outcome,
            failureStage: failure.stage,
          } : null,
        });
        runPublished = true;
        publishedRunPath = runPath;
        progress.clear();
        progressCleared = true;
        console.log(JSON.stringify({
          runPath,
          tenantStatePath: null,
          failure,
        }, null, 2));
        process.exitCode = failure.exitCode;
        return;
      } catch (publishError) {
        console.error(
          `Failed to publish partial run ${runId}: ${publishError instanceof Error ? publishError.stack : String(publishError)}`,
        );
      }
    }
    throw error;
  } finally {
    if (!progressCleared) progress.clear();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help') {
    console.log(usageText());
    return;
  }
  if (args.command === 'catalog-sync') {
    await runCatalogSync(args.provider);
    return;
  }
  if (args.command === 'repair-lever-description') {
    await runLeverDescriptionRepair(args);
    return;
  }
  await runScan(args);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
