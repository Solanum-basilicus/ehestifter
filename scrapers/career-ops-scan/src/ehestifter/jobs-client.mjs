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

async function getJsonWithRetry({ fetchImpl, url, headers, timeoutMs, retryCount }) {
  let lastError;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    let response;
    try {
      response = await fetchWithTimeout(fetchImpl, url, { method: 'GET', headers }, timeoutMs);
      if (response.ok) return await response.json();
      const body = await response.text().catch(() => '');
      const error = new Error(`Jobs API returned ${response.status}: ${body.slice(0, 500)}`);
      error.status = response.status;
      if (!isRetryable(null, response) || attempt === retryCount) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (attempt === retryCount || !isRetryable(error, response)) throw error;
    }
    await sleep(Math.min(500 * 2 ** attempt, 4000));
  }
  throw lastError;
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
    providerTenant:
      typeof payload.providerTenant === 'string'
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

  return {
    async existsByUrl(jobUrl) {
      const endpoint = new URL(`${config.baseUrl}/jobs/exists`);
      endpoint.searchParams.set('url', jobUrl);
      const payload = await getJsonWithRetry({
        fetchImpl,
        url: endpoint,
        headers,
        timeoutMs: config.timeoutMs,
        retryCount: config.retryCount,
      });
      return {
        exists: payload.exists === true,
        id: typeof payload.id === 'string' ? payload.id : null,
        identity: validateIdentity(payload),
        urlInference: extractUrlInference(payload),
      };
    },
  };
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function consume() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
  return results;
}

export async function preflightCandidates(candidates, client, concurrency) {
  return mapLimit(candidates, concurrency, async (candidate) => {
    try {
      const result = await client.existsByUrl(candidate.url);
      return {
        ...candidate,
        canonicalIdentity: result.identity,
        urlInference: result.urlInference,
        existingJobId: result.id,
        preflight: {
          status: 'ok',
          exists: result.exists,
        },
      };
    } catch (error) {
      return {
        ...candidate,
        preflight: {
          status: 'error',
          exists: null,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });
}
