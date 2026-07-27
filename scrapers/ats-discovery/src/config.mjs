import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

export const LIVE_CATALOG_HARD_MAX_TARGETS = 2000;

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function positiveInteger(value, fallback, name, { max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(
      `${name} must be a positive integer no greater than ${max}`,
    );
  }
  return value;
}

function nonNegativeInteger(value, fallback, name) {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function booleanValue(value, fallback, name) {
  if (value == null) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

function enumValue(value, fallback, name, allowed) {
  if (value == null) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

async function readSecret({ env, envName, fileEnvName }) {
  const direct = env[envName];
  if (direct?.trim()) return direct.trim();

  const filePath = env[fileEnvName];
  if (!filePath?.trim()) return null;
  const value = await readFile(filePath.trim(), 'utf8');
  return value.trim() || null;
}

async function requireReadable(filePath, name) {
  try {
    await access(filePath, fsConstants.R_OK);
  } catch (error) {
    throw new Error(`${name} is not readable: ${filePath}`, { cause: error });
  }
}

export function validateLiveCatalogTargetRequest({
  mode,
  requested,
  liveCatalog,
}) {
  const targetCount = requested ?? 0;
  if (!Number.isInteger(targetCount) || targetCount < 0) {
    throw new Error('requested live catalog targets must be a non-negative integer');
  }
  if (targetCount === 0) return 0;
  if (!['preflight', 'import'].includes(mode)) {
    throw new Error('live catalog targets are valid only for preflight or import');
  }
  if (!liveCatalog?.enabled) {
    throw new Error(
      'Catalog-backed preflight/import requires liveCatalog.enabled=true',
    );
  }
  const ceiling = mode === 'import'
    ? liveCatalog.maxImportTargetsPerRun
    : liveCatalog.maxPreflightTargetsPerRun;
  if (targetCount > ceiling) {
    throw new Error(
      `--catalog-targets ${targetCount} exceeds ${mode} ceiling ${ceiling}`,
    );
  }
  if (targetCount > LIVE_CATALOG_HARD_MAX_TARGETS) {
    throw new Error(
      `--catalog-targets cannot exceed ${LIVE_CATALOG_HARD_MAX_TARGETS}`,
    );
  }
  return targetCount;
}

export async function loadRuntimeConfig({
  mode = null,
  operation = 'scan',
  configPath = null,
  env = process.env,
} = {}) {
  const resolvedConfigPath = configPath
    ?? env.SCANNER_CONFIG_PATH
    ?? '/config/scanner.local.json';

  let raw;
  try {
    raw = JSON.parse(await readFile(resolvedConfigPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Scanner config is not valid readable JSON: ${resolvedConfigPath}`,
      { cause: error },
    );
  }
  requireObject(raw, 'scanner config');
  if (raw.schemaVersion !== 1) {
    throw new Error('scanner config schemaVersion must be 1');
  }

  const paths = requireObject(raw.paths, 'paths');
  const scan = requireObject(raw.scan ?? {}, 'scan');
  const description = requireObject(
    scan.description ?? {},
    'scan.description',
  );
  const imports = requireObject(raw.imports ?? {}, 'imports');
  const liveCatalog = requireObject(raw.liveCatalog ?? {}, 'liveCatalog');
  const jobsApi = requireObject(raw.jobsApi ?? {}, 'jobsApi');
  const usersApi = requireObject(raw.usersApi ?? {}, 'usersApi');
  const enrichmentApi = requireObject(raw.enrichmentApi ?? {}, 'enrichmentApi');
  const multiUser = requireObject(raw.multiUser ?? {}, 'multiUser');
  const compatibility = requireObject(
    multiUser.compatibility ?? {},
    'multiUser.compatibility',
  );
  const careerOps = requireObject(raw.careerOps ?? {}, 'careerOps');

  const dataPath = requireString(paths.data, 'paths.data');
  const catalogsPath = typeof paths.catalogs === 'string' && paths.catalogs.trim()
    ? paths.catalogs.trim()
    : path.join(dataPath, 'catalogs');
  const statePath = typeof paths.state === 'string' && paths.state.trim()
    ? paths.state.trim()
    : path.join(dataPath, 'state');

  const config = {
    configPath: resolvedConfigPath,
    paths: {
      portals: requireString(paths.portals, 'paths.portals'),
      companyOverrides: requireString(
        paths.companyOverrides ?? '/config/company-overrides.yml',
        'paths.companyOverrides',
      ),
      discoveryPolicy: requireString(
        paths.discoveryPolicy ?? '/config/discovery-policy.yml',
        'paths.discoveryPolicy',
      ),
      catalogs: catalogsPath,
      state: statePath,
      data: dataPath,
    },
    catalogs: {
      directory: catalogsPath,
      paths: Object.fromEntries(
        ['ashby', 'greenhouse', 'lever', 'workday']
          .map((provider) => [provider, path.join(catalogsPath, `${provider}.json`)]),
      ),
      // Compatibility alias for existing callers and operator scripts.
      ashbyPath: path.join(catalogsPath, 'ashby.json'),
    },
    state: {
      tenantStatePath: path.join(statePath, 'tenant-state.json'),
    },
    scan: {
      providerConcurrency: positiveInteger(
        scan.providerConcurrency,
        6,
        'scan.providerConcurrency',
      ),
      jobsApiConcurrency: positiveInteger(
        scan.jobsApiConcurrency,
        3,
        'scan.jobsApiConcurrency',
      ),
      maxCandidatesPerRun: positiveInteger(
        scan.maxCandidatesPerRun,
        100,
        'scan.maxCandidatesPerRun',
      ),
      requireDescriptionForCreate: booleanValue(
        scan.requireDescriptionForCreate,
        true,
        'scan.requireDescriptionForCreate',
      ),
      description: {
        fetchMissing: booleanValue(
          description.fetchMissing,
          true,
          'scan.description.fetchMissing',
        ),
        maxFetchesPerRun: positiveInteger(
          description.maxFetchesPerRun,
          50,
          'scan.description.maxFetchesPerRun',
        ),
        concurrency: positiveInteger(
          description.concurrency,
          2,
          'scan.description.concurrency',
        ),
        timeoutMs: positiveInteger(
          description.timeoutMs,
          30_000,
          'scan.description.timeoutMs',
        ),
      },
    },
    jobsApi: {
      baseUrl: typeof jobsApi.baseUrl === 'string'
        ? jobsApi.baseUrl.replace(/\/$/, '')
        : '',
      timeoutMs: positiveInteger(
        jobsApi.timeoutMs,
        15_000,
        'jobsApi.timeoutMs',
      ),
      retryCount: nonNegativeInteger(
        jobsApi.retryCount,
        2,
        'jobsApi.retryCount',
      ),
      functionKey: null,
    },
    usersApi: {
      baseUrl: typeof usersApi.baseUrl === 'string'
        ? usersApi.baseUrl.replace(/\/$/, '')
        : '',
      timeoutMs: positiveInteger(
        usersApi.timeoutMs,
        15_000,
        'usersApi.timeoutMs',
      ),
      retryCount: nonNegativeInteger(
        usersApi.retryCount,
        2,
        'usersApi.retryCount',
      ),
      maxUsersPerRun: positiveInteger(
        usersApi.maxUsersPerRun,
        100,
        'usersApi.maxUsersPerRun',
        { max: 1000 },
      ),
      functionKey: null,
    },
    enrichmentApi: {
      baseUrl: typeof enrichmentApi.baseUrl === 'string'
        ? enrichmentApi.baseUrl.replace(/\/$/, '')
        : '',
      timeoutMs: positiveInteger(
        enrichmentApi.timeoutMs,
        20_000,
        'enrichmentApi.timeoutMs',
      ),
      retryCount: nonNegativeInteger(
        enrichmentApi.retryCount,
        2,
        'enrichmentApi.retryCount',
      ),
      functionKey: null,
    },
    multiUser: {
      enabled: booleanValue(multiUser.enabled, false, 'multiUser.enabled'),
      portalFiltersMode: enumValue(
        multiUser.portalFiltersMode,
        'global_gate',
        'multiUser.portalFiltersMode',
        ['global_gate', 'scope_only'],
      ),
      compatibility: {
        enabled: booleanValue(
          compatibility.enabled,
          false,
          'multiUser.compatibility.enabled',
        ),
        enricherType: typeof compatibility.enricherType === 'string'
          && compatibility.enricherType.trim()
          ? compatibility.enricherType.trim()
          : 'compatibility.v1',
        concurrency: positiveInteger(
          compatibility.concurrency,
          2,
          'multiUser.compatibility.concurrency',
          { max: 10 },
        ),
        maxPairsPerRun: positiveInteger(
          compatibility.maxPairsPerRun,
          100,
          'multiUser.compatibility.maxPairsPerRun',
          { max: 1000 },
        ),
        maxRequestsPerRun: positiveInteger(
          compatibility.maxRequestsPerRun,
          20,
          'multiUser.compatibility.maxRequestsPerRun',
          { max: 200 },
        ),
        refreshSucceededWithUnknownCvVersion: booleanValue(
          compatibility.refreshSucceededWithUnknownCvVersion,
          false,
          'multiUser.compatibility.refreshSucceededWithUnknownCvVersion',
        ),
      },
    },
    careerOps: {
      upstreamRef: requireString(
        careerOps.upstreamRef,
        'careerOps.upstreamRef',
      ),
    },
    liveCatalog: {
      enabled: booleanValue(
        liveCatalog.enabled,
        false,
        'liveCatalog.enabled',
      ),
      maxPreflightTargetsPerRun: positiveInteger(
        liveCatalog.maxPreflightTargetsPerRun,
        100,
        'liveCatalog.maxPreflightTargetsPerRun',
        { max: LIVE_CATALOG_HARD_MAX_TARGETS },
      ),
      maxImportTargetsPerRun: positiveInteger(
        liveCatalog.maxImportTargetsPerRun,
        100,
        'liveCatalog.maxImportTargetsPerRun',
        { max: LIVE_CATALOG_HARD_MAX_TARGETS },
      ),
    },
    imports: {
      enabled: booleanValue(imports.enabled, false, 'imports.enabled'),
      maxCreatesPerRun: positiveInteger(
        imports.maxCreatesPerRun,
        5,
        'imports.maxCreatesPerRun',
      ),
    },
  };

  if (operation === 'scan') {
    await Promise.all([
      requireReadable(config.paths.portals, 'paths.portals'),
      requireReadable(
        config.paths.companyOverrides,
        'paths.companyOverrides',
      ),
      requireReadable(
        config.paths.discoveryPolicy,
        'paths.discoveryPolicy',
      ),
    ]);
  } else if (operation !== 'catalog-sync') {
    throw new Error(`Unknown config operation: ${operation}`);
  }

  if (operation === 'scan' && config.multiUser.enabled) {
    config.usersApi.baseUrl = requireString(
      config.usersApi.baseUrl,
      'usersApi.baseUrl',
    );
    config.usersApi.functionKey = await readSecret({
      env,
      envName: 'EHESTIFTER_USERS_FUNCTION_KEY',
      fileEnvName: 'EHESTIFTER_USERS_FUNCTION_KEY_FILE',
    });
    if (!config.usersApi.functionKey) {
      throw new Error(
        'Multi-user discovery requires EHESTIFTER_USERS_FUNCTION_KEY '
        + 'or EHESTIFTER_USERS_FUNCTION_KEY_FILE',
      );
    }
  }

  if (mode === 'preflight' || mode === 'import') {
    config.jobsApi.baseUrl = requireString(
      config.jobsApi.baseUrl,
      'jobsApi.baseUrl',
    );
    config.jobsApi.functionKey = await readSecret({
      env,
      envName: 'EHESTIFTER_JOBS_FUNCTION_KEY',
      fileEnvName: 'EHESTIFTER_JOBS_FUNCTION_KEY_FILE',
    });
    if (!config.jobsApi.functionKey) {
      throw new Error(
        'Preflight requires EHESTIFTER_JOBS_FUNCTION_KEY '
        + 'or EHESTIFTER_JOBS_FUNCTION_KEY_FILE',
      );
    }
    if (mode === 'import' && !config.imports.enabled) {
      throw new Error('Import mode requires imports.enabled=true');
    }
    if (
      mode === 'import'
      && config.multiUser.enabled
      && config.multiUser.compatibility.enabled
    ) {
      config.enrichmentApi.baseUrl = requireString(
        config.enrichmentApi.baseUrl,
        'enrichmentApi.baseUrl',
      );
      config.enrichmentApi.functionKey = await readSecret({
        env,
        envName: 'EHESTIFTER_ENRICHERS_FUNCTION_KEY',
        fileEnvName: 'EHESTIFTER_ENRICHERS_FUNCTION_KEY_FILE',
      });
      if (!config.enrichmentApi.functionKey) {
        throw new Error(
          'Compatibility requests require EHESTIFTER_ENRICHERS_FUNCTION_KEY '
          + 'or EHESTIFTER_ENRICHERS_FUNCTION_KEY_FILE',
        );
      }
    }
  }

  return config;
}
