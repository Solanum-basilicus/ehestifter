import { readFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

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

async function readSecret({ envName, fileEnvName }) {
  const direct = process.env[envName];
  if (direct?.trim()) return direct.trim();

  const filePath = process.env[fileEnvName];
  if (!filePath?.trim()) return null;
  const value = await readFile(filePath.trim(), 'utf8');
  return value.trim() || null;
}

export async function loadRuntimeConfig({ mode }) {
  const configPath = process.env.SCANNER_CONFIG_PATH || '/config/scanner.local.json';
  const raw = JSON.parse(await readFile(configPath, 'utf8'));
  requireObject(raw, 'scanner config');

  const paths = requireObject(raw.paths, 'paths');
  const scan = requireObject(raw.scan ?? {}, 'scan');
  const jobsApi = requireObject(raw.jobsApi ?? {}, 'jobsApi');
  const careerOps = requireObject(raw.careerOps ?? {}, 'careerOps');

  const config = {
    configPath,
    paths: {
      portals: requireString(paths.portals, 'paths.portals'),
      data: requireString(paths.data, 'paths.data'),
    },
    scan: {
      providerConcurrency: positiveInteger(scan.providerConcurrency, 6, 'scan.providerConcurrency'),
      jobsApiConcurrency: positiveInteger(scan.jobsApiConcurrency, 3, 'scan.jobsApiConcurrency'),
      maxCandidatesPerRun: positiveInteger(scan.maxCandidatesPerRun, 100, 'scan.maxCandidatesPerRun'),
    },
    jobsApi: {
      baseUrl: typeof jobsApi.baseUrl === 'string' ? jobsApi.baseUrl.replace(/\/$/, '') : '',
      timeoutMs: positiveInteger(jobsApi.timeoutMs, 15000, 'jobsApi.timeoutMs'),
      retryCount: Number.isInteger(jobsApi.retryCount) && jobsApi.retryCount >= 0
        ? jobsApi.retryCount
        : 2,
      functionKey: null,
    },
    careerOps: {
      upstreamRef: requireString(careerOps.upstreamRef, 'careerOps.upstreamRef'),
    },
  };

  await access(config.paths.portals, fsConstants.R_OK);

  if (mode === 'preflight') {
    config.jobsApi.baseUrl = requireString(config.jobsApi.baseUrl, 'jobsApi.baseUrl');
    config.jobsApi.functionKey = await readSecret({
      envName: 'EHESTIFTER_JOBS_FUNCTION_KEY',
      fileEnvName: 'EHESTIFTER_JOBS_FUNCTION_KEY_FILE',
    });
    if (!config.jobsApi.functionKey) {
      throw new Error(
        'Preflight requires EHESTIFTER_JOBS_FUNCTION_KEY or EHESTIFTER_JOBS_FUNCTION_KEY_FILE',
      );
    }
  }

  return config;
}
