import { randomUUID } from 'node:crypto';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isRetryable(error, response) {
  if (error) return true;
  return response.status === 429 || response.status >= 500;
}

const JOBS_STAGES = new Set(['db_acquire', 'db_query', 'db_transaction', 'request_handler']);
const JOBS_CATEGORIES = new Set([
  'pool_wait_timeout', 'db_connection_interface', 'db_connection_operational',
  'db_connection_unexpected', 'db_query_failed', 'db_transaction_failed',
  'internal_error',
]);
const JOBS_TIMINGS = new Set([
  'app', 'sql', 'dbconn', 'db_open', 'db_validate', 'db_pool_wait', 'process_age',
]);
const TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
  'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);

function elapsed(start) {
  return Math.max(0, Math.round(performance.now() - start));
}

function safeServerMetadata(response) {
  const stage = response.headers.get('x-jobs-failure-stage');
  const category = response.headers.get('x-jobs-failure-category');
  if (!JOBS_STAGES.has(stage) || !JOBS_CATEGORIES.has(category)) return null;
  const sqlState = response.headers.get('x-jobs-failure-sqlstate');
  return {
    stage, category,
    ...(sqlState && /^[A-Z0-9]{5}$/.test(sqlState) ? { sqlState } : {}),
  };
}

function safeServerTiming(response) {
  const header = response.headers.get('server-timing');
  if (typeof header !== 'string' || header.length > 4096) return null;
  const timingMs = {};
  let poolAction = null;
  let processFirst = null;
  for (const part of header.split(',').slice(0, 64)) {
    const value = part.trim();
    const match = /^([a-z][a-z0-9_]*);dur=(\d+(?:\.\d{1,2})?)$/.exec(value);
    if (match && JOBS_TIMINGS.has(match[1])) {
      const duration = Number(match[2]);
      if (Number.isFinite(duration) && duration <= 600000) timingMs[match[1]] = duration;
    }
    const pool = /^db_pool;desc="(hit|new|replaced|disabled)"$/.exec(value);
    if (pool) poolAction = pool[1];
    if (value === 'process_first;desc="1"') processFirst = true;
    if (value === 'process_first;desc="0"') processFirst = false;
  }
  return {
    timingMs,
    ...(poolAction ? { poolAction } : {}),
    ...(processFirst !== null ? { processFirst } : {}),
  };
}

function transportCategory(error) {
  const code = error?.cause?.code ?? error?.code;
  const safeCode = TRANSPORT_CODES.has(code) ? code : null;
  const timeout = ['AbortError', 'TimeoutError'].includes(error?.name)
    || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(safeCode);
  return { category: timeout ? 'transport_timeout' : 'transport_error',
    ...(safeCode ? { transportCode: safeCode } : {}) };
}

async function discardBody(response) {
  try { await response.body?.cancel(); } catch { /* Ignore failed cleanup. */ }
}

function safeRequestError(category, status, diagnostics, retriesExhausted) {
  const error = new Error(`Jobs request failed: ${category}`);
  error.category = category;
  error.status = status;
  error.attempts = diagnostics.attempts;
  error.retriesExhausted = retriesExhausted;
  error.requestDiagnostics = diagnostics;
  return error;
}

async function getJsonWithRetry({ fetchImpl, url, headers, timeoutMs, retryCount, path }) {
  const started = performance.now();
  const failedAttempts = [];
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    const correlationId = randomUUID();
    const attemptStarted = performance.now();
    const attemptNumber = attempt + 1;
    let response;
    try {
      response = await fetchWithTimeout(fetchImpl, url, {
        method: 'GET', headers: { ...headers, 'x-correlation-id': correlationId },
      }, timeoutMs);
    } catch (error) {
      const category = transportCategory(error);
      failedAttempts.push({
        attempt: attemptNumber, correlationId, httpStatus: null,
        durationMs: elapsed(attemptStarted), ...category,
      });
      if (attempt === retryCount) {
        throw safeRequestError(category.category, null, {
          path, correlationId, attempts: attemptNumber, httpStatus: null,
          durationMs: elapsed(started), failedAttempts,
        }, true);
      }
      await sleep(Math.min(500 * 2 ** attempt, 4000));
      continue;
    }
    const timing = safeServerTiming(response);
    const serverFailure = safeServerMetadata(response);
    if (response.ok) {
      try {
        const payload = await response.json();
        return { payload, requestDiagnostics: {
          path, correlationId, attempts: attemptNumber, httpStatus: response.status,
          durationMs: elapsed(started), failedAttempts,
          ...timing,
        } };
      } catch {
        failedAttempts.push({
          attempt: attemptNumber, correlationId, httpStatus: response.status,
          category: 'invalid_response', durationMs: elapsed(attemptStarted),
        });
        if (attempt === retryCount) {
          throw safeRequestError('invalid_response', response.status, {
            path, correlationId, attempts: attemptNumber, httpStatus: response.status,
            durationMs: elapsed(started), failedAttempts,
          }, true);
        }
        await sleep(Math.min(500 * 2 ** attempt, 4000));
        continue;
      }
    }
    const category = response.status === 429 ? 'http_rate_limited'
      : response.status >= 500 ? 'http_server_error' : 'http_client_error';
    await discardBody(response);
    failedAttempts.push({
      attempt: attemptNumber, correlationId, httpStatus: response.status,
      category, durationMs: elapsed(attemptStarted),
      ...(serverFailure ? { serverFailure } : {}),
      ...timing,
    });
    if (!isRetryable(null, response) || attempt === retryCount) {
      throw safeRequestError(category, response.status, {
        path, correlationId, attempts: attemptNumber, httpStatus: response.status,
        durationMs: elapsed(started), failedAttempts,
      }, attempt === retryCount);
    }
    await sleep(Math.min(500 * 2 ** attempt, 4000));
  }
  throw new Error('Unreachable Jobs retry state');
}

function validateIdentity(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Jobs API returned invalid JSON');
  }
  if (typeof payload.provider !== 'string' || payload.provider.trim() === '') {
    throw new Error('Jobs API response is missing provider');
  }
  if (typeof payload.externalId !== 'string' || payload.externalId.trim() === '') {
    throw new Error('Jobs API response is missing externalId');
  }
  return {
    provider: payload.provider.trim(),
    providerTenant: typeof payload.providerTenant === 'string'
      ? payload.providerTenant.trim()
      : '',
    externalId: payload.externalId.trim(),
    identitySource: payload.identitySource ?? null,
  };
}

function extractUrlInference(payload) {
  return {
    foundOn: payload.foundOn ?? null,
    hiringCompanyName: payload.hiringCompanyName ?? null,
    postingCompanyName: payload.postingCompanyName ?? null,
  };
}

export function createJobsClient(config, { fetchImpl = fetch } = {}) {
  const headers = {
    accept: 'application/json',
    'x-functions-key': config.functionKey,
    'x-actor-type': 'system',
    'x-source-surface': 'system',
  };

  async function existsByUrl(jobUrl) {
    const endpoint = new URL(`${config.baseUrl}/jobs/exists`);
    endpoint.searchParams.set('url', jobUrl);
    const { payload, requestDiagnostics } = await getJsonWithRetry({
      fetchImpl,
      url: endpoint,
      headers,
      timeoutMs: config.timeoutMs,
      retryCount: config.retryCount,
      path: '/jobs/exists',
    });
    return {
      requestDiagnostics,
      exists: payload.exists === true,
      id: typeof payload.id === 'string' ? payload.id : null,
      identity: validateIdentity(payload),
      urlInference: extractUrlInference(payload),
    };
  }

  async function existsByIdentity(identity) {
    const provider = typeof identity?.provider === 'string'
      ? identity.provider.trim()
      : '';
    const providerTenant = typeof identity?.providerTenant === 'string'
      ? identity.providerTenant.trim()
      : '';
    const externalId = typeof identity?.externalId === 'string'
      ? identity.externalId.trim()
      : '';
    if (!provider || !externalId) {
      throw new Error('Explicit job identity requires provider and externalId');
    }
    const endpoint = new URL(`${config.baseUrl}/jobs/exists`);
    endpoint.searchParams.set('provider', provider);
    endpoint.searchParams.set('providerTenant', providerTenant);
    endpoint.searchParams.set('externalId', externalId);
    const { payload, requestDiagnostics } = await getJsonWithRetry({
      fetchImpl,
      url: endpoint,
      headers,
      timeoutMs: config.timeoutMs,
      retryCount: config.retryCount,
      path: '/jobs/exists',
    });
    return {
      requestDiagnostics,
      exists: payload.exists === true,
      id: typeof payload.id === 'string' ? payload.id : null,
      identity: validateIdentity(payload),
      urlInference: extractUrlInference(payload),
    };
  }

  async function getJob(jobId) {
    const normalizedId = typeof jobId === 'string' ? jobId.trim() : '';
    if (!normalizedId) throw new Error('jobId must be a non-empty string');
    const endpoint = new URL(
      `${config.baseUrl}/jobs/${encodeURIComponent(normalizedId)}`,
    );
    const { payload } = await getJsonWithRetry({
      fetchImpl, url: endpoint, headers,
      timeoutMs: config.timeoutMs, retryCount: config.retryCount,
      path: '/jobs/{id}',
    });
    return payload;
  }

  async function updateJobDescription(jobId, description) {
    const normalizedId = typeof jobId === 'string' ? jobId.trim() : '';
    if (!normalizedId) throw new Error('jobId must be a non-empty string');
    if (typeof description !== 'string' || description.trim() === '') {
      throw new Error('description must be a non-empty string');
    }

    const endpoint = new URL(
      `${config.baseUrl}/jobs/${encodeURIComponent(normalizedId)}`,
    );
    let lastError = null;
    for (let attempt = 0; attempt <= config.retryCount; attempt += 1) {
      const correlationId = randomUUID();
      let response = null;
      try {
        response = await fetchWithTimeout(
          fetchImpl,
          endpoint,
          {
            method: 'PUT',
            headers: {
              ...headers,
              'x-correlation-id': correlationId,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ description }),
          },
          config.timeoutMs,
        );
      } catch (error) {
        lastError = new Error(`Jobs request failed: ${transportCategory(error).category}`);
      }

      if (response?.ok) {
        return { responseStatus: response.status };
      }
      if (response) {
        await discardBody(response);
        const error = new Error(`Jobs API returned ${response.status}`);
        error.status = response.status;
        lastError = error;
        if (!isRetryable(null, response)) throw error;
      }
      if (attempt === config.retryCount) {
        throw lastError ?? new Error('Jobs update failed without an error');
      }
      await sleep(Math.min(500 * 2 ** attempt, 4000));
    }
    throw lastError ?? new Error('Jobs update failed without an error');
  }

  async function createJob(
    payload,
    { reconcileUrl = payload.url, reconcileIdentity = null } = {},
  ) {
    const endpoint = new URL(`${config.baseUrl}/jobs`);
    let lastError = null;
    for (let attempt = 0; attempt <= config.retryCount; attempt += 1) {
      const correlationId = randomUUID();
      let response = null;
      try {
        response = await fetchWithTimeout(
          fetchImpl,
          endpoint,
          {
            method: 'POST',
            headers: {
              ...headers,
              'x-correlation-id': correlationId,
              'content-type': 'application/json',
            },
            body: JSON.stringify(payload),
          },
          config.timeoutMs,
        );
      } catch (error) {
        lastError = new Error(`Jobs request failed: ${transportCategory(error).category}`);
      }

      if (response?.ok) {
        try {
          const body = await response.json();
          if (!body || typeof body.id !== 'string' || body.id.trim() === '') {
            throw new Error('Jobs create response is missing id');
          }
          return {
            id: body.id.trim(),
            disposition: 'submitted',
            reconciled: false,
            responseStatus: response.status,
          };
        } catch (error) {
          lastError = new Error('Jobs create response is invalid');
        }
      } else if (response) {
        await discardBody(response);
        const error = new Error(`Jobs API returned ${response.status}`);
        error.status = response.status;
        lastError = error;
        if (!isRetryable(null, response)) throw error;
      }

      /* An ambiguous POST may have committed before its response was lost. */
      try {
        const reconciliation = reconcileIdentity
          ? await existsByIdentity(reconcileIdentity)
          : await existsByUrl(reconcileUrl);
        if (reconciliation.exists && reconciliation.id) {
          return {
            id: reconciliation.id,
            disposition: 'reconciled_after_ambiguous_post',
            reconciled: true,
            responseStatus: response?.status ?? null,
          };
        }
      } catch {
        /* Preserve the POST failure as the primary error. */
      }

      if (attempt === config.retryCount) {
        throw lastError ?? new Error('Jobs create failed without an error');
      }
      await sleep(Math.min(500 * 2 ** attempt, 4000));
    }
    throw lastError ?? new Error('Jobs create failed without an error');
  }

  return {
    existsByUrl,
    existsByIdentity,
    getJob,
    updateJobDescription,
    createJob,
  };
}

function safeProgress(onProgress, value) {
  if (!onProgress) return;
  try {
    onProgress(value);
  } catch {
    /* Progress is diagnostic and must not affect Jobs calls. */
  }
}

async function mapLimit(items, limit, worker, onProgress, onResult = null) {
  const results = new Array(items.length);
  let next = 0;
  let completed = 0;
  async function consume() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
      if (onResult) {
        try {
          onResult(results[index], index);
        } catch {
          /* Run journaling must never alter Jobs calls. */
        }
      }
      completed += 1;
      safeProgress(onProgress, {
        stage: 'preflight',
        current: completed,
        total: items.length,
      });
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => consume()),
  );
  return results;
}

function withPrivateDiagnostics(candidate, diagnostics) {
  if (diagnostics) {
    // Keep normal attempt details out of plaintext run artifacts.
    Object.defineProperty(candidate, '_jobsHttpDiagnostics', {
      value: diagnostics, enumerable: false,
    });
  }
  return candidate;
}

export async function preflightCandidates(
  candidates,
  client,
  concurrency,
  { onProgress = null, onResult = null } = {},
) {
  return mapLimit(
    candidates,
    concurrency,
    async (candidate) => {
      try {
        const result = candidate.explicitIdentity
          ? await client.existsByIdentity(candidate.explicitIdentity)
          : await client.existsByUrl(candidate.url);
        const diag = result.requestDiagnostics;
        return withPrivateDiagnostics({
          ...candidate,
          canonicalIdentity: result.identity,
          urlInference: result.urlInference,
          existingJobId: result.id,
          preflight: {
            status: 'ok',
            exists: result.exists,
            ...(diag?.failedAttempts?.length ? { requestDiagnostics: diag } : {}),
          },
        }, diag);
      } catch (error) {
        const diag = error?.requestDiagnostics;
        return withPrivateDiagnostics({
          ...candidate,
          preflight: {
            status: 'error',
            exists: null,
            error: diag ? error.message : 'Jobs preflight failed',
            ...(diag ? { requestDiagnostics: diag } : {}),
          },
        }, diag);
      }
    },
    onProgress,
    onResult,
  );
}
