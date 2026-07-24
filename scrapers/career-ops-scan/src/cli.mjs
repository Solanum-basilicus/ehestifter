#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRunId, writeRunArtifacts } from './artifacts/run-writer.mjs';
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
import { importCandidates } from './ehestifter/import-jobs.mjs';
import { createJobsClient, preflightCandidates } from './ehestifter/jobs-client.mjs';
import { normalizeCandidateLocations } from './locations/normalizer.mjs';
import { loadProviders } from './providers/_registry.mjs';
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

async function runScan(args) {
  const progress = createProgressRenderer({
    enabled: args.noProgress ? false : 'auto',
  });
  let progressCleared = false;

  try {
    const startedAt = new Date();
    const runId = createRunId(startedAt);
    const config = await loadRuntimeConfig({
      operation: 'scan',
      mode: args.mode,
    });
    const requestedCatalogTargets = validateLiveCatalogTargetRequest({
      mode: args.mode,
      requested: args.catalogTargets,
      liveCatalog: config.liveCatalog,
    });

    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const providersDir = path.join(moduleDir, 'providers');
    const providers = await loadProviders(providersDir);
    if (providers.size === 0) {
      throw new Error(`No providers loaded from ${providersDir}`);
    }

    const planning = await buildTargetPlanFromFiles({
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

    progress.update({
      stage: 'scan',
      current: 0,
      total: planning.runtimeTargets.length,
    });
    const scanResult = await runTrackedScan({
      portalConfig: planning.portalConfig,
      targets: planning.runtimeTargets,
      providers,
      policy: planning.policy,
      concurrency: config.scan.providerConcurrency,
      maxCandidates: config.scan.maxCandidatesPerRun,
      upstreamRef: config.careerOps.upstreamRef,
      onProgress: (event) => progress.update({
        ...event,
        detail: progressDetail(event),
      }),
    });

    let canaryDetailResults = null;
    if (scanResult.canaryCandidates.length > 0) {
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
    const hasCanaryTargets = planning.runtimeTargets.some(
      (target) => target.canary != null,
    );
    const canaryResults = hasCanaryTargets
      ? buildProviderCanaryResults({
        targets: planning.runtimeTargets,
        providerResults: scanResult.providerResults,
        detailResults: canaryDetailResults ?? [],
        generatedAt: new Date(),
      })
      : null;

    let client = null;
    let preflightResults = null;
    if (args.mode === 'preflight' || args.mode === 'import') {
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

    let detailResults = null;
    if (
      (args.mode === 'preflight' || args.mode === 'import')
      && config.scan.description.fetchMissing
    ) {
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

    let locationResults = null;
    if (args.mode === 'preflight' || args.mode === 'import') {
      locationResults = normalizeCandidateLocations(
        detailResults ?? preflightResults,
      );
    }

    let importResults = null;
    if (args.mode === 'import') {
      if (args.maxCreate > config.imports.maxCreatesPerRun) {
        throw new Error(
          `--max-create ${args.maxCreate} exceeds imports.maxCreatesPerRun `
          + `${config.imports.maxCreatesPerRun}`,
        );
      }
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

    const evaluated = importResults
      ?? locationResults
      ?? detailResults
      ?? preflightResults
      ?? scanResult.candidates;
    const finishedAt = new Date();

    const rateObservations = buildRateObservations({
      providerResults: scanResult.providerResults,
      breakerEvents: scanResult.breakerEvents,
      policy: planning.policy,
      targetPlan: planning.plan,
      generatedAt: finishedAt,
    });

    const shouldPersistTenantState = args.mode === 'offline'
      || planning.plan.counts.normal > 0;
    let nextTenantState = null;
    let tenantStateChanges = null;
    if (shouldPersistTenantState) {
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

    const summary = buildRunSummary({
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
    });

    const rejected = [
      ...planning.planningRejections,
      ...scanResult.rejected,
    ];
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
      candidates: scanResult.candidates,
      rejected,
      preflightResults,
      detailResults,
      locationResults,
      importResults,
      summary,
    });

    if (nextTenantState) {
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
    ) {
      process.exitCode = 2;
    }
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
  await runScan(args);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
