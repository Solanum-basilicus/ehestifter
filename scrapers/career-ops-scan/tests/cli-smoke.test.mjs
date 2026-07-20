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
import assert from 'node:assert/strict';

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

async function withTempDir(worker) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cli-smoke-'));
  try {
    return await worker(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('CLI help loads the real import graph without requiring config', async () => {
  const result = await runNode([cliPath, '--help']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /catalog sync ashby/);
  assert.match(result.stdout, /scan tracked --offline/);
});

test('CLI catalog sync branch writes catalog and does not enter scan orchestration', async () => {
  await withTempDir(async (directory) => {
    const dataPath = path.join(directory, 'data');
    const configPath = path.join(directory, 'scanner.json');
    const preloadPath = path.join(directory, 'fake-fetch.mjs');

    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      careerOps: { upstreamRef: 'test-ref' },
      paths: {
        portals: path.join(directory, 'missing-portals.yml'),
        companyOverrides: path.join(directory, 'missing-overrides.yml'),
        discoveryPolicy: path.join(directory, 'missing-policy.yml'),
        catalogs: path.join(dataPath, 'catalogs'),
        data: dataPath,
      },
      scan: {},
      jobsApi: {},
      imports: {},
    }));

    await writeFile(preloadPath, `
      const bytes = Buffer.from('["n8n"]', 'utf8');
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        headers: { get: () => String(bytes.length) },
        arrayBuffer: async () => bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      });
    `);

    const existingNodeOptions = process.env.NODE_OPTIONS?.trim() ?? '';
    const importOption = `--import=${pathToFileURL(preloadPath).href}`;
    const result = await runNode(
      [cliPath, 'catalog', 'sync', 'ashby'],
      {
        env: {
          SCANNER_CONFIG_PATH: configPath,
          NODE_OPTIONS: [existingNodeOptions, importOption]
            .filter(Boolean)
            .join(' '),
        },
      },
    );

    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.summary.provider, 'ashby');
    assert.equal(output.summary.acceptedItemCount, 1);

    const persisted = JSON.parse(
      await readFile(path.join(dataPath, 'catalogs', 'ashby.json'), 'utf8'),
    );
    assert.deepEqual(persisted.tenants, ['n8n']);
  });
});

test('CLI offline branch publishes Phase 3 artifacts and scanner-owned state without network targets', async () => {
  await withTempDir(async (directory) => {
    const dataPath = path.join(directory, 'data');
    const configPath = path.join(directory, 'scanner.json');
    const portalsPath = path.join(directory, 'portals.yml');
    const overridesPath = path.join(directory, 'overrides.yml');
    const policyPath = path.join(directory, 'policy.yml');

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
      scan: { providerConcurrency: 3, maxCandidatesPerRun: 100 },
      jobsApi: {},
      imports: {},
    }));

    const result = await runNode(
      [cliPath, 'scan', 'tracked', '--offline'],
      { env: { SCANNER_CONFIG_PATH: configPath } },
    );
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.summary.targetsPlanned, 0);
    assert.equal(output.tenantStatePath, path.join(dataPath, 'state', 'tenant-state.json'));

    const files = await import('node:fs/promises').then(({ readdir }) => readdir(output.runPath));
    assert.ok(files.includes('tenant-state-changes.json'));
    assert.ok(files.includes('rate-observations.json'));
    const state = JSON.parse(
      await readFile(path.join(dataPath, 'state', 'tenant-state.json'), 'utf8'),
    );
    assert.equal(state.schemaVersion, 1);
  });
});
