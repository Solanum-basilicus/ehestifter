#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntimeConfig } from './config.mjs';
import { runTrackedScan } from './scan/tracked-source.mjs';
import { createJobsClient, preflightCandidates } from './ehestifter/jobs-client.mjs';
import { createRunId, writeRunArtifacts } from './artifacts/run-writer.mjs';
import { enrichCandidateDetails } from './details/fetchers.mjs';
import { importCandidates, } from './ehestifter/import-jobs.mjs';
import { normalizeCandidateLocations, } from './locations/normalizer.mjs';

function usage() {
  console.log(`Usage:
  node src/cli.mjs scan tracked --offline
  node src/cli.mjs scan tracked --preflight
  node src/cli.mjs scan tracked --import --max-create N
`);
}

function parseArgs(argv) {
  if (
    argv.includes('--help')
    || argv.includes('-h')
  ) {
    return {
      help: true,
    };
  }

  const [command, source, ...flags] = argv;

  if (
    command !== 'scan'
    || source !== 'tracked'
  ) {
    throw new Error(
      'Only "scan tracked" is currently implemented',
    );
  }

  let mode = null;
  let maxCreate = null;

  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];

    if (
      flag === '--offline'
      || flag === '--preflight'
      || flag === '--import'
    ) {
      if (mode !== null) {
        throw new Error(
          'Choose exactly one mode',
        );
      }

      mode = flag.slice(2);
      continue;
    }

    if (flag === '--max-create') {
      const rawValue = flags[index + 1];
      const value = Number.parseInt(rawValue, 10);

      if (
        !rawValue
        || !Number.isInteger(value)
        || value <= 0
        || String(value) !== rawValue
      ) {
        throw new Error(
          '--max-create requires a positive integer',
        );
      }

      maxCreate = value;
      index += 1;
      continue;
    }

    throw new Error(
      `Unknown argument: ${flag}`,
    );
  }

  if (mode === null) {
    throw new Error(
      'Choose one of --offline, --preflight, or --import',
    );
  }

  if (mode === 'import' && maxCreate === null) {
    throw new Error(
      'Import mode requires --max-create N',
    );
  }

  if (mode !== 'import' && maxCreate !== null) {
    throw new Error(
      '--max-create is valid only with --import',
    );
  }

  return {
    help: false,
    mode,
    maxCreate,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const startedAt = new Date();
  const runId = createRunId(startedAt);
  const config = await loadRuntimeConfig({ mode: args.mode });
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const providersDir = path.join(moduleDir, 'providers');

  const scanResult = await runTrackedScan({
    portalsPath: config.paths.portals,
    providersDir,
    concurrency: config.scan.providerConcurrency,
    maxCandidates: config.scan.maxCandidatesPerRun,
    upstreamRef: config.careerOps.upstreamRef,
  });

  let client = null;
  let preflightResults = null;

  if (
    args.mode === 'preflight'
    || args.mode === 'import'
  ) {
    // Assignment, not "const client": retain the value for import mode.
    client = createJobsClient(config.jobsApi);

    preflightResults = await preflightCandidates(
      scanResult.candidates,
      client,
      config.scan.jobsApiConcurrency,
    );
  }

  let detailResults = null;

  if (
    (
      args.mode === 'preflight'
      || args.mode === 'import'
    )
    && config.scan.description.fetchMissing
  ) {
    detailResults = await enrichCandidateDetails(
      preflightResults,
      {
        concurrency:
          config.scan.description.concurrency,
        maxFetches:
          config.scan.description.maxFetchesPerRun,
        timeoutMs:
          config.scan.description.timeoutMs,
      },
    );
  }

  let locationResults = null;

  if (
    args.mode === 'preflight'
    || args.mode === 'import'
  ) {
    locationResults =
      normalizeCandidateLocations(
        detailResults ?? preflightResults,
      );
  }

  // Must be in main() scope, outside the detail-fetch block.
  let importResults = null;

  if (args.mode === 'import') {
    if (
      args.maxCreate
      > config.imports.maxCreatesPerRun
    ) {
      throw new Error(
        `--max-create ${args.maxCreate} exceeds `
        + `imports.maxCreatesPerRun `
        + `${config.imports.maxCreatesPerRun}`,
      );
    }

    importResults = await importCandidates(
      locationResults,
      client,
      {
        maxCreates: args.maxCreate,
        requireDescription:
          config.scan.requireDescriptionForCreate,
      },
    );
  }

  const finishedAt = new Date();
  const evaluated =
    importResults
    ?? locationResults    
    ?? detailResults
    ?? preflightResults
    ?? scanResult.candidates;
  const summary = {
    schemaVersion: 1,
    runId,
    mode: args.mode,
    startedAtUtc: startedAt.toISOString(),
    finishedAtUtc: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    targets: scanResult.targetCount,
    providersLoaded: scanResult.providerIds,
    candidates: scanResult.candidates.length,
    rejected: scanResult.rejected.length,
    preflightExisting: evaluated.filter((job) => job.preflight?.status === 'ok' && job.preflight.exists).length,
    preflightMissing: evaluated.filter((job) => job.preflight?.status === 'ok' && !job.preflight.exists).length,
    preflightErrors: evaluated.filter((job) => job.preflight?.status === 'error').length,
    detailReady: evaluated.filter(
      (job) => job.detail?.status === 'ok',
    ).length,

    detailAlreadyPresent: evaluated.filter(
      (job) => job.detail?.status === 'already_present',
    ).length,

    detailExistingSkipped: evaluated.filter(
      (job) => job.detail?.status === 'skipped_existing',
    ).length,

    detailUnsupported: evaluated.filter(
      (job) => job.detail?.status === 'unsupported_provider',
    ).length,

    detailErrors: evaluated.filter(
      (job) => job.detail?.status === 'error',
    ).length,

    candidateDescriptionsMissing: evaluated.filter(
      (job) =>
        typeof job.description !== 'string'
        || job.description.trim() === '',
    ).length,

    missingDescriptionsForImport: evaluated.filter(
      (job) =>
        job.preflight?.status === 'ok'
        && job.preflight.exists === false
        && (
          typeof job.description !== 'string'
          || job.description.trim() === ''
        ),
    ).length,

    importExisting: evaluated.filter(
      (job) =>
        job.import?.status === 'existing_preflight',
    ).length,

    importSubmitted: evaluated.filter(
      (job) =>
        job.import?.status === 'submitted',
    ).length,

    importReconciled: evaluated.filter(
      (job) =>
        job.import?.status
          === 'reconciled_after_ambiguous_post',
    ).length,

    importSkipped: evaluated.filter(
      (job) =>
        typeof job.import?.status === 'string'
        && job.import.status.startsWith('skipped_'),
    ).length,

    importErrors: evaluated.filter(
      (job) =>
        job.import?.status === 'error',
    ).length,

    locationProviderStructured: evaluated.filter(
      (job) =>
        job.locationNormalization?.status
          === 'provider_structured',
    ).length,

    locationNormalized: evaluated.filter(
      (job) =>
        job.locationNormalization?.status
          === 'normalized_city_country'
        || job.locationNormalization?.status
          === 'normalized_country'
        || job.locationNormalization?.status
          === 'normalized_country_scope',
    ).length,

    locationUnparsed: evaluated.filter(
      (job) =>
        typeof job.locationNormalization?.status
          === 'string'
        && job.locationNormalization.status.startsWith(
          'unparsed_',
        ),
    ).length,

    locationMissing: evaluated.filter(
      (job) =>
        job.locationNormalization?.status
          === 'missing',
    ).length,    
  };

  const runPath = await writeRunArtifacts({
    dataPath: config.paths.data,
    runId,
    metadata: {
      schemaVersion: 1,
      runId,
      mode: args.mode,
      scannerConfigPath: config.configPath,
      careerOpsUpstreamRef:
        config.careerOps.upstreamRef,
    },
    candidates: scanResult.candidates,
    rejected: scanResult.rejected,
    importResults,
    locationResults,
    preflightResults,
    detailResults,
    summary,
  });

  console.log(JSON.stringify({ runPath, summary }, null, 2));
  if (
    summary.preflightErrors > 0
    || summary.importErrors > 0
  ) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
