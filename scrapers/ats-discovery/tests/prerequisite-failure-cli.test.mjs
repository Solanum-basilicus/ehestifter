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
import { fileURLToPath, pathToFileURL } from 'node:url';
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
    child.on('close', (code, signal) => resolve({
      code,
      signal,
      stdout,
      stderr,
    }));
  });
}

test('CLI publishes retryable prerequisite abort before provider state changes', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cli-prerequisite-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const dataPath = path.join(directory, 'data');
  const configPath = path.join(directory, 'scanner.json');
  const portalsPath = path.join(directory, 'portals.yml');
  const overridesPath = path.join(directory, 'overrides.yml');
  const policyPath = path.join(directory, 'policy.yml');
  const preloadPath = path.join(directory, 'failed-users-fetch.mjs');

  await writeFile(portalsPath, JSON.stringify({ tracked_companies: [] }));
  await writeFile(overridesPath, JSON.stringify({
    schema_version: 1,
    priority: { ashby: [] },
    disabled: { ashby: [] },
  }));
  await writeFile(policyPath, JSON.stringify({
    schema_version: 1,
    providers: {
      ashby: {
        catalog_enabled: false,
        max_normal_targets_per_run: 100,
        target_full_sweep_days: 3,
      },
    },
  }));
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    careerOps: { upstreamRef: 'test-ref' },
    paths: {
      portals: portalsPath,
      companyOverrides: overridesPath,
      discoveryPolicy: policyPath,
      catalogs: path.join(dataPath, 'catalogs'),
      state: path.join(dataPath, 'state'),
      data: dataPath,
    },
    scan: { providerConcurrency: 1, maxCandidatesPerRun: 10 },
    jobsApi: {},
    imports: {},
    usersApi: {
      baseUrl: 'https://users.example.test/api',
      timeoutMs: 100,
      retryCount: 0,
      maxUsersPerRun: 10,
    },
    multiUser: {
      enabled: true,
      portalFiltersMode: 'scope_only',
      compatibility: { enabled: false },
    },
  }));
  await writeFile(preloadPath, `
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('network unreachable'), {
          code: 'ENETUNREACH',
          syscall: 'connect',
          hostname: 'users.example.test',
        }),
      });
    };
  `);

  const existingNodeOptions = process.env.NODE_OPTIONS?.trim() ?? '';
  const importOption = `--import=${pathToFileURL(preloadPath).href}`;
  const result = await runNode(
    [cliPath, 'scan', 'tracked', '--offline', '--no-progress'],
    {
      env: {
        SCANNER_CONFIG_PATH: configPath,
        EHESTIFTER_USERS_FUNCTION_KEY: 'test-secret',
        NODE_OPTIONS: [existingNodeOptions, importOption]
          .filter(Boolean)
          .join(' '),
      },
    },
  );

  assert.equal(result.code, 75, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.summary.runStatus, 'aborted_retryable');
  assert.equal(output.summary.failureStage, 'discovery_users_load');
  assert.equal(output.summary.targetsAttempted, 0);
  assert.equal(output.tenantStatePath, null);

  const failure = JSON.parse(
    await readFile(path.join(output.runPath, 'failure.json'), 'utf8'),
  );
  assert.equal(failure.retryable, true);
  assert.equal(failure.error.chain[1].code, 'ENETUNREACH');

  const providerResults = JSON.parse(
    await readFile(path.join(output.runPath, 'provider-results.json'), 'utf8'),
  );
  assert.deepEqual(providerResults.results, []);
  await assert.rejects(
    readFile(path.join(dataPath, 'state', 'tenant-state.json'), 'utf8'),
    { code: 'ENOENT' },
  );
});
