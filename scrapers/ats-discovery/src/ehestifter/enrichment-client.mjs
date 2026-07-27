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

async function responseError(response, service) {
  const body = await response.text().catch(() => '');
  const error = new Error(
    `${service} returned ${response.status}: ${body.slice(0, 500)}`,
  );
  error.status = response.status;
  return error;
}

export function createEnrichmentClient(config, { fetchImpl = fetch } = {}) {
  const headers = {
    accept: 'application/json',
    'x-functions-key': config.functionKey,
    'x-actor-type': 'system',
    'x-source-surface': 'system',
  };

  async function requestWithRetry(url, options, { allowNotFound = false } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= config.retryCount; attempt += 1) {
      let response = null;
      try {
        response = await fetchWithTimeout(
          fetchImpl,
          url,
          options,
          config.timeoutMs,
        );
        if (allowNotFound && response.status === 404) return null;
        if (response.ok) return await response.json();
        lastError = await responseError(response, 'Enrichment API');
        if (response.status !== 429 && response.status < 500) throw lastError;
      } catch (error) {
        lastError = error;
        if (response?.ok) throw error;
        if (
          error?.status
          && error.status !== 429
          && error.status < 500
        ) throw error;
        if (attempt === config.retryCount) throw error;
      }
      if (attempt === config.retryCount) break;
      await sleep(Math.min(500 * 2 ** attempt, 4000));
    }
    throw lastError ?? new Error('Enrichment API request failed');
  }

  async function getLatest(jobId, userId, enricherType) {
    const endpoint = new URL(
      `${config.baseUrl}/enrichment/subjects/${encodeURIComponent(jobId)}`
      + `/${encodeURIComponent(userId)}/latest`,
    );
    endpoint.searchParams.set('enricherType', enricherType);
    return requestWithRetry(
      endpoint,
      { method: 'GET', headers },
      { allowNotFound: true },
    );
  }

  async function createRun(jobId, userId, enricherType) {
    const endpoint = new URL(`${config.baseUrl}/enrichment/runs`);
    return requestWithRetry(endpoint, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        jobOfferingId: jobId,
        userId,
        enricherType,
      }),
    });
  }

  return { getLatest, createRun };
}
