import {
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadRuntimeConfig } from '../src/config.mjs';

async function withTempDir(worker) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scanner-config-'));
  try {
    return await worker(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function configFor(directory, overrides = {}) {
  return {
    schemaVersion: 1,
    careerOps: { upstreamRef: 'upstream-ref' },
    paths: {
      portals: path.join(directory, 'portals.yml'),
      companyOverrides: path.join(directory, 'company-overrides.yml'),
      discoveryPolicy: path.join(directory, 'discovery-policy.yml'),
      catalogs: path.join(directory, 'catalogs'),
      data: path.join(directory, 'data'),
    },
    scan: {
      providerConcurrency: 3,
      jobsApiConcurrency: 3,
      maxCandidatesPerRun: 100,
      description: {},
    },
    jobsApi: {
      baseUrl: 'https://jobs.example/api/',
      timeoutMs: 1000,
      retryCount: 0,
    },
    imports: {
      enabled: true,
      maxCreatesPerRun: 2,
    },
    ...overrides,
  };
}

async function writeScanFiles(directory) {
  await Promise.all([
    writeFile(path.join(directory, 'portals.yml'), '{}\n'),
    writeFile(path.join(directory, 'company-overrides.yml'), '{}\n'),
    writeFile(path.join(directory, 'discovery-policy.yml'), '{}\n'),
  ]);
}


test('scanner config schema version is enforced', async () => {
  await withTempDir(async (directory) => {
    const configPath = path.join(directory, 'scanner.json');
    const raw = configFor(directory);
    raw.schemaVersion = 2;
    await writeFile(configPath, JSON.stringify(raw));

    await assert.rejects(
      loadRuntimeConfig({ configPath, operation: 'catalog-sync' }),
      /schemaVersion must be 1/,
    );
  });
});

test('loadRuntimeConfig returns Phase 2 paths and derived Ashby path', async () => {
  await withTempDir(async (directory) => {
    await writeScanFiles(directory);
    const configPath = path.join(directory, 'scanner.json');
    await writeFile(configPath, JSON.stringify(configFor(directory)));

    const config = await loadRuntimeConfig({ configPath, operation: 'scan' });
    assert.equal(config.paths.companyOverrides, path.join(directory, 'company-overrides.yml'));
    assert.equal(config.paths.discoveryPolicy, path.join(directory, 'discovery-policy.yml'));
    assert.equal(config.paths.catalogs, path.join(directory, 'catalogs'));
    assert.equal(config.catalogs.ashbyPath, path.join(directory, 'catalogs', 'ashby.json'));
    assert.equal(config.scan.providerConcurrency, 3);
    assert.equal(config.jobsApi.baseUrl, 'https://jobs.example/api');
    assert.equal(config.jobsApi.retryCount, 0);
  });
});

test('scan config loading does not require the catalog file itself', async () => {
  await withTempDir(async (directory) => {
    await writeScanFiles(directory);
    const configPath = path.join(directory, 'scanner.json');
    await writeFile(configPath, JSON.stringify(configFor(directory)));

    const config = await loadRuntimeConfig({ configPath, operation: 'scan' });
    assert.equal(config.catalogs.ashbyPath.endsWith('ashby.json'), true);
  });
});

test('scan operation fails clearly when a required policy file is missing', async () => {
  await withTempDir(async (directory) => {
    await writeFile(path.join(directory, 'portals.yml'), '{}\n');
    await writeFile(path.join(directory, 'company-overrides.yml'), '{}\n');
    const configPath = path.join(directory, 'scanner.json');
    await writeFile(configPath, JSON.stringify(configFor(directory)));

    await assert.rejects(
      loadRuntimeConfig({ configPath, operation: 'scan' }),
      /paths.discoveryPolicy is not readable/,
    );
  });
});

test('catalog sync operation does not require scan policy files', async () => {
  await withTempDir(async (directory) => {
    const configPath = path.join(directory, 'scanner.json');
    await writeFile(configPath, JSON.stringify(configFor(directory)));

    const config = await loadRuntimeConfig({
      configPath,
      operation: 'catalog-sync',
    });
    assert.equal(config.catalogs.ashbyPath, path.join(directory, 'catalogs', 'ashby.json'));
  });
});

test('preflight retains existing function-key requirements', async () => {
  await withTempDir(async (directory) => {
    await writeScanFiles(directory);
    const configPath = path.join(directory, 'scanner.json');
    await writeFile(configPath, JSON.stringify(configFor(directory)));

    await assert.rejects(
      loadRuntimeConfig({
        configPath,
        operation: 'scan',
        mode: 'preflight',
        env: {},
      }),
      /Preflight requires/,
    );

    const config = await loadRuntimeConfig({
      configPath,
      operation: 'scan',
      mode: 'preflight',
      env: { EHESTIFTER_JOBS_FUNCTION_KEY: 'secret-key' },
    });
    assert.equal(config.jobsApi.functionKey, 'secret-key');
  });
});

test('import mode still requires imports.enabled=true', async () => {
  await withTempDir(async (directory) => {
    await writeScanFiles(directory);
    const configPath = path.join(directory, 'scanner.json');
    const raw = configFor(directory);
    raw.imports.enabled = false;
    await writeFile(configPath, JSON.stringify(raw));

    await assert.rejects(
      loadRuntimeConfig({
        configPath,
        operation: 'scan',
        mode: 'import',
        env: { EHESTIFTER_JOBS_FUNCTION_KEY: 'secret-key' },
      }),
      /imports.enabled=true/,
    );
  });
});
