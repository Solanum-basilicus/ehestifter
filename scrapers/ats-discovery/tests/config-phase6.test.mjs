import assert from 'node:assert/strict';
import {
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadRuntimeConfig } from '../src/config.mjs';

async function withConfig(raw, worker) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'phase6-config-'));
  try {
    const paths = {
      portals: path.join(directory, 'portals.yml'),
      companyOverrides: path.join(directory, 'company-overrides.yml'),
      discoveryPolicy: path.join(directory, 'discovery-policy.yml'),
      catalogs: path.join(directory, 'catalogs'),
      data: path.join(directory, 'data'),
      state: path.join(directory, 'state'),
    };
    await Promise.all([
      writeFile(paths.portals, '{}\n'),
      writeFile(paths.companyOverrides, '{}\n'),
      writeFile(paths.discoveryPolicy, '{}\n'),
    ]);
    const configPath = path.join(directory, 'scanner.json');
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      careerOps: { upstreamRef: 'ref' },
      paths,
      scan: { description: {} },
      jobsApi: { baseUrl: 'https://jobs.example/api' },
      usersApi: { baseUrl: 'https://users.example/api' },
      enrichmentApi: { baseUrl: 'https://enrichers.example/api' },
      imports: { enabled: true },
      ...raw,
    }));
    return await worker(configPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('multi-user discovery is disabled by default and requires no extra secrets', async () => {
  await withConfig({}, async (configPath) => {
    const config = await loadRuntimeConfig({
      configPath,
      operation: 'scan',
      mode: 'offline',
      env: {},
    });
    assert.equal(config.multiUser.enabled, false);
    assert.equal(config.multiUser.compatibility.enabled, false);
    assert.equal(config.usersApi.functionKey, null);
  });
});

test('enabled multi-user discovery requires Users base URL and function key', async () => {
  await withConfig({ multiUser: { enabled: true } }, async (configPath) => {
    await assert.rejects(
      loadRuntimeConfig({ configPath, operation: 'scan', mode: 'offline', env: {} }),
      /EHESTIFTER_USERS_FUNCTION_KEY/,
    );
    const config = await loadRuntimeConfig({
      configPath,
      operation: 'scan',
      mode: 'offline',
      env: { EHESTIFTER_USERS_FUNCTION_KEY: 'users-secret' },
    });
    assert.equal(config.usersApi.functionKey, 'users-secret');
    assert.equal(config.usersApi.maxUsersPerRun, 100);
  });
});

test('compatibility requests are import-only and require the Enrichment key', async () => {
  const multiUser = { enabled: true, compatibility: { enabled: true } };
  await withConfig({ multiUser }, async (configPath) => {
    const offline = await loadRuntimeConfig({
      configPath,
      operation: 'scan',
      mode: 'offline',
      env: { EHESTIFTER_USERS_FUNCTION_KEY: 'users-secret' },
    });
    assert.equal(offline.enrichmentApi.functionKey, null);

    await assert.rejects(
      loadRuntimeConfig({
        configPath,
        operation: 'scan',
        mode: 'import',
        env: {
          EHESTIFTER_USERS_FUNCTION_KEY: 'users-secret',
          EHESTIFTER_JOBS_FUNCTION_KEY: 'jobs-secret',
        },
      }),
      /EHESTIFTER_ENRICHERS_FUNCTION_KEY/,
    );

    const imported = await loadRuntimeConfig({
      configPath,
      operation: 'scan',
      mode: 'import',
      env: {
        EHESTIFTER_USERS_FUNCTION_KEY: 'users-secret',
        EHESTIFTER_JOBS_FUNCTION_KEY: 'jobs-secret',
        EHESTIFTER_ENRICHERS_FUNCTION_KEY: 'enrichers-secret',
      },
    });
    assert.equal(imported.enrichmentApi.functionKey, 'enrichers-secret');
    assert.equal(imported.multiUser.compatibility.maxRequestsPerRun, 20);
  });
});

test('Phase 6 limits and booleans are strictly bounded', async () => {
  await withConfig({
    usersApi: { baseUrl: 'https://users.example/api', maxUsersPerRun: 1001 },
  }, async (configPath) => {
    await assert.rejects(
      loadRuntimeConfig({ configPath, operation: 'scan', mode: 'offline' }),
      /maxUsersPerRun/,
    );
  });
  await withConfig({
    multiUser: {
      enabled: true,
      compatibility: { enabled: true, maxRequestsPerRun: 201 },
    },
  }, async (configPath) => {
    await assert.rejects(
      loadRuntimeConfig({
        configPath,
        operation: 'scan',
        mode: 'import',
        env: {
          EHESTIFTER_USERS_FUNCTION_KEY: 'u',
          EHESTIFTER_JOBS_FUNCTION_KEY: 'j',
          EHESTIFTER_ENRICHERS_FUNCTION_KEY: 'e',
        },
      }),
      /maxRequestsPerRun/,
    );
  });
});

test('portal filter mode is conservative by default and validates explicit scope-only mode', async () => {
  await withConfig({}, async (configPath) => {
    const config = await loadRuntimeConfig({
      configPath,
      operation: 'scan',
      mode: 'offline',
      env: {},
    });
    assert.equal(config.multiUser.portalFiltersMode, 'global_gate');
  });

  await withConfig({
    multiUser: { enabled: true, portalFiltersMode: 'scope_only' },
  }, async (configPath) => {
    const config = await loadRuntimeConfig({
      configPath,
      operation: 'scan',
      mode: 'offline',
      env: { EHESTIFTER_USERS_FUNCTION_KEY: 'users-secret' },
    });
    assert.equal(config.multiUser.portalFiltersMode, 'scope_only');
  });

  await withConfig({
    multiUser: { portalFiltersMode: 'everything' },
  }, async (configPath) => {
    await assert.rejects(
      loadRuntimeConfig({
        configPath,
        operation: 'scan',
        mode: 'offline',
        env: {},
      }),
      /multiUser\.portalFiltersMode must be one of/,
    );
  });
});
