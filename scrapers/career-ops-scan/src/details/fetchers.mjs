import { htmlToPlainText } from './text.mjs';

const GREENHOUSE_HOST = 'boards-api.greenhouse.io';
const ASHBY_HOST = 'api.ashbyhq.com';

function safeProgress(onProgress, value) {
  if (!onProgress) return;
  try {
    onProgress(value);
  } catch {
    /* Progress is diagnostic and must not affect detail fetching. */
  }
}

function mapLimit(items, limit, worker, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let completed = 0;
  async function consume() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
      completed += 1;
      safeProgress(onProgress, {
        stage: 'details',
        current: completed,
        total: items.length,
      });
    }
  }
  return Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => consume()),
  ).then(() => results);
}

async function fetchJsonWithTimeout({
  fetchImpl,
  url,
  timeoutMs,
  options = {},
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      ...options,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(options.headers ?? {}),
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Detail endpoint returned ${response.status}: ${body.slice(0, 500)}`,
      );
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function assertEndpointHost(endpoint, expectedHost) {
  if (endpoint.protocol !== 'https:') {
    throw new Error(`Detail URL must use HTTPS: ${endpoint}`);
  }
  if (endpoint.hostname !== expectedHost) {
    throw new Error(
      `Unexpected detail endpoint host ${endpoint.hostname}; expected ${expectedHost}`,
    );
  }
}

function normalizeRemoteType(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  if (normalized === 'remote') return 'Remote';
  if (normalized === 'hybrid') return 'Hybrid';
  if (normalized === 'onsite' || normalized === 'inoffice') return 'On-site';
  return null;
}

function ashbyLocations(job) {
  const postal = job?.address?.postalAddress;
  if (
    !postal
    || typeof postal.addressCountry !== 'string'
    || postal.addressCountry.trim() === ''
  ) {
    return [];
  }
  return [{
    countryName: postal.addressCountry.trim(),
    countryCode: null,
    cityName: typeof postal.addressLocality === 'string'
      ? postal.addressLocality.trim() || null
      : null,
    region: typeof postal.addressRegion === 'string'
      ? postal.addressRegion.trim() || null
      : null,
  }];
}

async function fetchGreenhouseDetails(candidate, context) {
  const tenant = candidate.canonicalIdentity?.providerTenant;
  const externalId = candidate.canonicalIdentity?.externalId;
  if (!tenant || !externalId) {
    throw new Error('Greenhouse detail fetch requires tenant and externalId');
  }
  const endpoint = new URL(
    `https://${GREENHOUSE_HOST}/v1/boards/${encodeURIComponent(tenant)}`
    + `/jobs/${encodeURIComponent(externalId)}`,
  );
  assertEndpointHost(endpoint, GREENHOUSE_HOST);
  const payload = await fetchJsonWithTimeout({
    fetchImpl: context.fetchImpl,
    url: endpoint,
    timeoutMs: context.timeoutMs,
  });
  return {
    description: htmlToPlainText(payload.content),
    descriptionStatus: 'greenhouse-detail-api',
    applyUrl: typeof payload.absolute_url === 'string'
      ? payload.absolute_url.trim()
      : null,
    locations: [],
    remoteType: null,
  };
}

async function fetchAshbyBoard(tenant, context) {
  const endpoint = new URL(
    `https://${ASHBY_HOST}/posting-api/job-board/${encodeURIComponent(tenant)}`,
  );
  endpoint.searchParams.set('includeCompensation', 'true');
  assertEndpointHost(endpoint, ASHBY_HOST);
  const cacheKey = endpoint.toString();
  if (!context.ashbyBoardCache.has(cacheKey)) {
    context.ashbyBoardCache.set(
      cacheKey,
      fetchJsonWithTimeout({
        fetchImpl: context.fetchImpl,
        url: endpoint,
        timeoutMs: context.timeoutMs,
      }),
    );
  }
  return await context.ashbyBoardCache.get(cacheKey);
}

async function fetchAshbyDetails(candidate, context) {
  const tenant = candidate.canonicalIdentity?.providerTenant;
  const externalId = candidate.canonicalIdentity?.externalId;
  if (!tenant || !externalId) {
    throw new Error('Ashby detail fetch requires tenant and externalId');
  }
  const payload = await fetchAshbyBoard(tenant, context);
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  const job = jobs.find(
    (item) => String(item?.id ?? '') === String(externalId),
  );
  if (!job) {
    throw new Error(`Ashby job ${externalId} was not present on board ${tenant}`);
  }
  const plain = typeof job.descriptionPlain === 'string'
    ? job.descriptionPlain.trim()
    : '';
  return {
    description: plain || htmlToPlainText(job.descriptionHtml),
    descriptionStatus: 'ashby-board-api',
    applyUrl: typeof job.applyUrl === 'string' ? job.applyUrl.trim() : null,
    locations: ashbyLocations(job),
    remoteType: normalizeRemoteType(job.workplaceType),
  };
}

async function fetchDetails(candidate, context) {
  const provider = candidate.canonicalIdentity?.provider;
  switch (provider) {
    case 'greenhouse':
      return { supported: true, ...(await fetchGreenhouseDetails(candidate, context)) };
    case 'ashby':
      return { supported: true, ...(await fetchAshbyDetails(candidate, context)) };
    default:
      return { supported: false, provider };
  }
}

export async function enrichCandidateDetails(
  candidates,
  {
    concurrency,
    maxFetches,
    timeoutMs,
    fetchImpl = fetch,
    onProgress = null,
  },
) {
  const context = {
    fetchImpl,
    timeoutMs,
    ashbyBoardCache: new Map(),
  };
  const eligibleIndices = [];
  const output = candidates.map((candidate, index) => {
    if (candidate.preflight?.status !== 'ok') {
      return {
        ...candidate,
        detail: { status: 'skipped_preflight_error' },
      };
    }
    if (candidate.preflight.exists) {
      return {
        ...candidate,
        detail: { status: 'skipped_existing' },
      };
    }
    if (
      typeof candidate.description === 'string'
      && candidate.description.trim() !== ''
    ) {
      return {
        ...candidate,
        detail: {
          status: 'already_present',
          descriptionStatus: candidate.descriptionStatus,
        },
      };
    }
    eligibleIndices.push(index);
    return candidate;
  });

  const selectedIndices = eligibleIndices.slice(0, maxFetches);
  const limitedIndices = eligibleIndices.slice(maxFetches);
  for (const index of limitedIndices) {
    output[index] = {
      ...output[index],
      detail: { status: 'skipped_limit' },
    };
  }

  const fetched = await mapLimit(
    selectedIndices,
    concurrency,
    async (index) => {
      const candidate = output[index];
      try {
        const details = await fetchDetails(candidate, context);
        if (!details.supported) {
          return {
            index,
            candidate: {
              ...candidate,
              detail: {
                status: 'unsupported_provider',
                provider: candidate.canonicalIdentity?.provider ?? null,
              },
            },
          };
        }
        const description = typeof details.description === 'string'
          ? details.description.trim()
          : '';
        return {
          index,
          candidate: {
            ...candidate,
            applyUrl: details.applyUrl || candidate.applyUrl || candidate.url,
            description,
            descriptionStatus: description
              ? details.descriptionStatus
              : 'missing',
            locations: Array.isArray(details.locations)
              && details.locations.length > 0
              ? details.locations
              : candidate.locations,
            remoteType: details.remoteType || candidate.remoteType,
            detail: {
              status: description ? 'ok' : 'missing_description',
              provider: candidate.canonicalIdentity?.provider ?? null,
              descriptionStatus: description
                ? details.descriptionStatus
                : 'missing',
            },
          },
        };
      } catch (error) {
        return {
          index,
          candidate: {
            ...candidate,
            detail: {
              status: 'error',
              provider: candidate.canonicalIdentity?.provider ?? null,
              error: error instanceof Error ? error.message : String(error),
            },
          },
        };
      }
    },
    onProgress,
  );

  for (const item of fetched) output[item.index] = item.candidate;
  return output;
}
