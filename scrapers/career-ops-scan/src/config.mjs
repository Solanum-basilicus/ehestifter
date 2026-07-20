import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

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

function positiveInteger(value, fallback, name) {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
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
  const jobsApi = requireObject(raw.jobsApi ?? {}, 'jobsApi');
  const careerOps = requireObject(raw.careerOps ?? {}, 'careerOps');

  const dataPath = requireString(paths.data, 'paths.data');
  const catalogsPath = typeof paths.catalogs === 'string' && paths.catalogs.trim()
    ? paths.catalogs.trim()
    : path.join(dataPath, 'catalogs');

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
      data: dataPath,
    },
    catalogs: {
      ashbyPath: path.join(catalogsPath, 'ashby.json'),
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
    careerOps: {
      upstreamRef: requireString(
        careerOps.upstreamRef,
        'careerOps.upstreamRef',
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
  }

  return config;
}
