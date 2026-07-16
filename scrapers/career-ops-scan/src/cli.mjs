#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntimeConfig } from './config.mjs';
import { runTrackedScan } from './scan/tracked-source.mjs';
import { createJobsClient, preflightCandidates } from './ehestifter/jobs-client.mjs';
import { createRunId, writeRunArtifacts } from './artifacts/run-writer.mjs';
import { enrichCandidateDetails } from './details/fetchers.mjs';

function usage() {
  console.log(`Usage:
  node src/cli.mjs scan tracked --offline
  node src/cli.mjs scan tracked --preflight

Phase 1A/B intentionally has no --import mode.`);
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const [command, source, ...flags] = argv;
  if (command !== 'scan' || source !== 'tracked') {
    throw new Error('Only "scan tracked" is implemented in Phase 1A/B');
  }
  const modes = flags.filter((flag) => flag === '--offline' || flag === '--preflight');
  if (modes.length !== 1) {
    throw new Error('Choose exactly one of --offline or --preflight');
  }
  const unknown = flags.filter((flag) => !['--offline', '--preflight'].includes(flag));
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(', ')}`);
  return { help: false, mode: modes[0].slice(2) };
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

  let preflightResults = null;
  if (args.mode === 'preflight') {
    const client = createJobsClient(config.jobsApi);
    preflightResults = await preflightCandidates(
      scanResult.candidates,
      client,
      config.scan.jobsApiConcurrency,
    );
  }

  let detailResults = null;

  if (
    args.mode === 'preflight'
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

  const finishedAt = new Date();
  const evaluated =
    detailResults
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

    missingDescriptions: evaluated.filter(
      (job) =>
        typeof job.description !== 'string'
        || job.description.trim() === '',
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
    preflightResults,
    detailResults,
    summary,
  });

  console.log(JSON.stringify({ runPath, summary }, null, 2));
  if (summary.preflightErrors > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
