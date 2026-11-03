import { randomUUID } from 'node:crypto';

const PATH = '/enrichment/runs';
const SERVER_STAGES = new Set([
  'run_create', 'run_readback', 'analytics', 'job_snapshot', 'cv_snapshot',
  'snapshot_validate', 'blob_upload', 'snapshot_path_update',
  'gateway_dispatch', 'mark_queued',
]);
const SERVER_CATEGORIES = new Set([
  'db_connection_interface', 'db_connection_operational',
  'db_connection_unexpected', 'db_subject_lock', 'db_sql', 'db_operation',
  'upstream_timeout', 'upstream_http_5xx', 'upstream_http_4xx',
  'upstream_transport', 'invalid_snapshot', 'snapshot_storage',
  'gateway_dispatch', 'gateway_http_5xx', 'gateway_http_4xx',
  'upstream_invalid_response', 'internal_error',
]);

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

function serverDiagnostic(response) {
  const stage = response.headers.get('x-enrichment-failure-stage');
  const category = response.headers.get('x-enrichment-failure-category');
  if (!SERVER_STAGES.has(stage) || !SERVER_CATEGORIES.has(category)) return null;
  const sqlState = response.headers.get('x-enrichment-failure-sqlstate');
  const upstreamStatus = Number(response.headers.get('x-enrichment-failure-upstream-status'));
  const gatewayTarget = response.headers.get('x-enrichment-failure-gateway-target');
  return {
    stage, category,
    ...(sqlState && /^[A-Z0-9]{5}$/.test(sqlState) ? { sqlState } : {}),
    ...(Number.isInteger(upstreamStatus) && upstreamStatus >= 300 && upstreamStatus <= 599
      ? { upstreamStatus } : {}),
    ...(['primary', 'alternative'].includes(gatewayTarget)
      ? { gatewayTarget } : {}),
  };
}

const TIMING_KEYS = new Set([
  'app', 'process_age', 'step_run_create', 'step_run_readback',
  'step_analytics', 'step_job_snapshot', 'step_cv_snapshot',
  'step_snapshot_validate', 'step_blob_upload', 'step_snapshot_path_update',
  'step_gateway_dispatch', 'step_mark_queued', 'users_http', 'gateway_http',
]);

function safeServerTiming(response) {
  const header = response.headers.get('server-timing');
  if (typeof header !== 'string' || header.length > 4096) return null;
  const timingMs = {};
  let processFirst = null;
  for (const part of header.split(',').slice(0, 32)) {
    const value = part.trim();
    if (value === 'process_first;desc="1"') processFirst = true;
    if (value === 'process_first;desc="0"') processFirst = false;
    const match = /^([a-z][a-z0-9_]*);dur=(\d+(?:\.\d{1,2})?)$/.exec(value);
    if (!match || !TIMING_KEYS.has(match[1])) continue;
    const ms = Number(match[2]);
    if (Number.isFinite(ms) && ms <= 600000) timingMs[match[1]] = ms;
  }
  if (!Object.keys(timingMs).length && processFirst === null) return null;
  return { ...(Object.keys(timingMs).length ? { timingMs } : {}),
    ...(processFirst !== null ? { processFirst } : {}) };
}

async function discardFailureBody(response) {
  // Do not read or store error bodies. Close the stream before a retry.
  try {
    await response.body?.cancel();
  } catch {
    // A failed cancel must not change the request outcome.
  }
}

function httpCategory(status) {
  if (status === 429) return 'http_rate_limited';
  if (status >= 500) return 'http_server_error';
  return 'http_client_error';
}

const TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
  'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
]);

function transportCode(error) {
  const code = error?.cause?.code ?? error?.code;
  return TRANSPORT_CODES.has(code) ? code : null;
}

function transportCategory(error) {
  return ['AbortError', 'TimeoutError'].includes(error?.name)
    || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']
      .includes(transportCode(error))
    ? 'transport_timeout' : 'transport_error';
}

function elapsed(start) {
  return Math.max(0, Math.round(performance.now() - start));
}

function requestDiagnostics({ correlationId, status, attempts, started, failures, serverFailure, serverTiming }) {
  return {
    path: PATH,
    correlationId,
    httpStatus: status,
    attempts,
    durationMs: elapsed(started),
    // Only failures are stored per attempt. Normal traffic has one ID.
    failedAttempts: failures,
    ...(serverFailure ? { serverFailure } : {}),
    ...(serverFailure && serverTiming ? { serverTiming } : {}),
  };
}

function safeError(category, status, diagnostics, retriesExhausted) {
  const error = new Error(`Enrichment request failed: ${category}`);
  error.category = category;
  error.status = status;
  error.attempts = diagnostics.attempts;
  error.retriesExhausted = retriesExhausted;
  error.requestDiagnostics = diagnostics;
  return error;
}

export function createEnrichmentClient(config, { fetchImpl = fetch } = {}) {
  const headers = {
    accept: 'application/json',
    'x-functions-key': config.functionKey,
    'x-actor-type': 'system',
    'x-source-surface': 'system',
  };

  async function requestWithRetry(url, options) {
    const started = performance.now();
    const failedAttempts = [];
    for (let attempt = 0; attempt <= config.retryCount; attempt += 1) {
      const correlationId = randomUUID();
      const attemptStarted = performance.now();
      const attemptNumber = attempt + 1;
      let response;
      try {
        response = await fetchWithTimeout(fetchImpl, url, {
          ...options,
          headers: { ...options.headers, 'x-correlation-id': correlationId },
        }, config.timeoutMs);
      } catch (error) {
        const category = transportCategory(error);
        const code = transportCode(error);
        failedAttempts.push({
          attempt: attemptNumber, correlationId, httpStatus: null,
          category, durationMs: elapsed(attemptStarted),
          ...(code ? { transportCode: code } : {}),
        });
        if (attempt === config.retryCount) {
          throw safeError(category, null, requestDiagnostics({
            correlationId, status: null, attempts: attemptNumber,
            started, failures: failedAttempts,
          }), true);
        }
        await sleep(Math.min(500 * 2 ** attempt, 4000));
        continue;
      }

      const serverFailure = serverDiagnostic(response);
      const serverTiming = safeServerTiming(response);
      if (response.ok) {
        let data;
        try {
          data = await response.json();
          if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new TypeError('Invalid Enrichment response');
          }
        } catch {
          const category = 'invalid_response';
          failedAttempts.push({
            attempt: attemptNumber, correlationId, httpStatus: response.status,
            category, durationMs: elapsed(attemptStarted),
          });
          throw safeError(category, response.status, requestDiagnostics({
            correlationId, status: response.status, attempts: attemptNumber,
            started, failures: failedAttempts, serverFailure, serverTiming,
          }), false);
        }
        return {
          ...data,
          requestDiagnostics: requestDiagnostics({
            correlationId, status: response.status, attempts: attemptNumber,
            started, failures: failedAttempts, serverFailure, serverTiming,
          }),
        };
      }

      const category = httpCategory(response.status);
      await discardFailureBody(response);
      failedAttempts.push({
        attempt: attemptNumber, correlationId, httpStatus: response.status,
        category, durationMs: elapsed(attemptStarted),
        ...(serverFailure ? { serverFailure } : {}),
        ...(serverTiming ? { serverTiming } : {}),
      });
      if ((response.status !== 429 && response.status < 500)
          || attempt === config.retryCount) {
        throw safeError(category, response.status, requestDiagnostics({
          correlationId, status: response.status, attempts: attemptNumber,
          started, failures: failedAttempts, serverFailure,
        }), attempt === config.retryCount);
      }
      await sleep(Math.min(500 * 2 ** attempt, 4000));
    }
    // The loop always returns or throws.
    throw new Error('Unreachable retry state');
  }

  async function createRun(jobId, userId, enricherType) {
    const endpoint = new URL(`${config.baseUrl}${PATH}`);
    return requestWithRetry(endpoint, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        jobOfferingId: jobId,
        userId,
        enricherType,
        requestMode: 'automatic',
      }),
    });
  }

  return { createRun };
}
