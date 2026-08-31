import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const scannerRoot = path.dirname(testDir);
const cliPath = path.join(scannerRoot, 'src', 'cli.mjs');

function runNode(args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: scannerRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('import cap mismatch fails before scanning and publishes a partial run', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cli-runtime-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const dataPath = path.join(directory, 'data');
  const configPath = path.join(directory, 'scanner.json');
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    careerOps: { upstreamRef: 'test-ref' },
    paths: {
      portals: path.join(directory, 'portals.yml'),
      companyOverrides: path.join(directory, 'overrides.yml'),
      discoveryPolicy: path.join(directory, 'policy.yml'),
      catalogs: path.join(dataPath, 'catalogs'),
      state: path.join(dataPath, 'state'),
      data: dataPath,
    },
    scan: {
      providerConcurrency: 1,
      jobsApiConcurrency: 1,
      maxCandidatesPerRun: 10,
      requireDescriptionForCreate: true,
      description: {
        fetchMissing: true,
        maxFetchesPerRun: 10,
        concurrency: 1,
        timeoutMs: 1000,
      },
    },
    jobsApi: {
      baseUrl: 'https://jobs.example.test/api',
      timeoutMs: 1000,
      retryCount: 0,
    },
    imports: { enabled: true, maxCreatesPerRun: 1 },
    liveCatalog: {
      enabled: false,
      maxPreflightTargetsPerRun: 10,
      maxImportTargetsPerRun: 10,
    },
    usersApi: {
      baseUrl: 'https://users.example.test/api',
      timeoutMs: 1000,
      retryCount: 0,
      maxUsersPerRun: 10,
    },
    enrichmentApi: {
      baseUrl: 'https://enrichment.example.test/api',
      timeoutMs: 1000,
      retryCount: 0,
    },
    multiUser: {
      enabled: false,
      portalFiltersMode: 'scope_only',
      compatibility: { enabled: false },
    },
  }));

  const result = await runNode(
    [cliPath, 'scan', 'tracked', '--import', '--max-create', '2', '--no-progress'],
    {
      env: {
        SCANNER_CONFIG_PATH: configPath,
        EHESTIFTER_JOBS_FUNCTION_KEY: 'test-secret',
      },
    },
  );

  assert.equal(result.code, 64, result.stderr);
  const output = JSON.parse(result.stdout);
  const failure = JSON.parse(await readFile(path.join(output.runPath, 'failure.json'), 'utf8'));
  const metadata = JSON.parse(await readFile(path.join(output.runPath, 'metadata.json'), 'utf8'));
  assert.equal(failure.stage, 'runtime_config_validation');
  assert.equal(failure.retryable, false);
  assert.match(failure.error.message, /max-create 2.*maxCreatesPerRun 1/u);
  assert.equal(metadata.partial, true);
  await assert.rejects(readFile(path.join(output.runPath, 'target-plan.json'), 'utf8'), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(output.runPath, 'provider-results.json'), 'utf8'), { code: 'ENOENT' });
});
