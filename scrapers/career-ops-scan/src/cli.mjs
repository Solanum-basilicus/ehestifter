#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRunId, writeRunArtifacts } from './artifacts/run-writer.mjs';
import { catalogSyncSummary, syncAshbyCatalog } from './catalogs/sync-ashby.mjs';
import { parseArgs, usageText } from './cli-args.mjs';
import { loadRuntimeConfig } from './config.mjs';
import { enrichCandidateDetails } from './details/fetchers.mjs';
import { importCandidates } from './ehestifter/import-jobs.mjs';
import { createJobsClient, preflightCandidates } from './ehestifter/jobs-client.mjs';
import { normalizeCandidateLocations } from './locations/normalizer.mjs';
import { loadProviders } from './providers/_registry.mjs';
import { buildRunSummary } from './run-summary.mjs';
import { runTrackedScan } from './scan/tracked-source.mjs';
import { buildTargetPlanFromFiles } from './targets/planner.mjs';

function assertNoCatalogTargetsOutsideOffline(mode, runtimeTargets) {
  if (
    mode !== 'offline'
    && runtimeTargets.some((target) => target.targetClass === 'normal')
  ) {
    throw new Error(
      'Safety invariant violated: catalog targets are allowed only in offline mode',
    );
  }
}

async function runCatalogSync() {
  const config = await loadRuntimeConfig({ operation: 'catalog-sync' });
  const catalog = await syncAshbyCatalog({
    outputPath: config.catalogs.ashbyPath,
  });
  console.log(JSON.stringify({
    outputPath: config.catalogs.ashbyPath,
    summary: catalogSyncSummary(catalog),
  }, null, 2));
}

async function runScan(args) {
  const startedAt = new Date();
  const runId = createRunId(startedAt);
  const config = await loadRuntimeConfig({
    operation: 'scan',
    mode: args.mode,
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
    ashbyCatalogPath: config.catalogs.ashbyPath,
    providers,
    mode: args.mode,
    generatedAt: startedAt,
  });
  assertNoCatalogTargetsOutsideOffline(args.mode, planning.runtimeTargets);

  const scanResult = await runTrackedScan({
    portalConfig: planning.portalConfig,
    targets: planning.runtimeTargets,
    providers,
    concurrency: config.scan.providerConcurrency,
    maxCandidates: config.scan.maxCandidatesPerRun,
    upstreamRef: config.careerOps.upstreamRef,
  });

  let client = null;
  let preflightResults = null;
  if (args.mode === 'preflight' || args.mode === 'import') {
    client = createJobsClient(config.jobsApi);
    preflightResults = await preflightCandidates(
      scanResult.candidates,
      client,
      config.scan.jobsApiConcurrency,
    );
  }

  let detailResults = null;
  if (
    (args.mode === 'preflight' || args.mode === 'import')
    && config.scan.description.fetchMissing
  ) {
    detailResults = await enrichCandidateDetails(preflightResults, {
      concurrency: config.scan.description.concurrency,
      maxFetches: config.scan.description.maxFetchesPerRun,
      timeoutMs: config.scan.description.timeoutMs,
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
    importResults = await importCandidates(locationResults, client, {
      maxCreates: args.maxCreate,
      requireDescription: config.scan.requireDescriptionForCreate,
    });
  }

  const evaluated = importResults
    ?? locationResults
    ?? detailResults
    ?? preflightResults
    ?? scanResult.candidates;
  const finishedAt = new Date();
  const summary = buildRunSummary({
    runId,
    mode: args.mode,
    startedAt,
    finishedAt,
    targetPlan: planning.plan,
    scanResult,
    evaluated,
  });

  const rejected = [
    ...planning.planningRejections,
    ...scanResult.rejected,
  ];
  const runPath = await writeRunArtifacts({
    dataPath: config.paths.data,
    runId,
    metadata: {
      schemaVersion: 1,
      runId,
      mode: args.mode,
      scannerConfigPath: config.configPath,
      careerOpsUpstreamRef: config.careerOps.upstreamRef,
      catalogAshbySha256: planning.plan.catalogs.ashby?.rawSha256 ?? null,
    },
    targetPlan: planning.plan,
    providerResults: scanResult.providerResults,
    candidates: scanResult.candidates,
    rejected,
    preflightResults,
    detailResults,
    locationResults,
    importResults,
    summary,
  });

  console.log(JSON.stringify({ runPath, summary }, null, 2));
  if (summary.preflightErrors > 0 || summary.importErrors > 0) {
    process.exitCode = 2;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help') {
    console.log(usageText());
    return;
  }
  if (args.command === 'catalog-sync') {
    await runCatalogSync();
    return;
  }
  await runScan(args);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
