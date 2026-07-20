import { performance } from 'node:perf_hooks';

import { makeHttpCtx } from '../providers/_http.mjs';
import {
  buildContentFilter,
  buildLocationFilter,
  buildPostingAgeFilter,
  buildSalaryFilter,
  buildTitleFilter,
  matchedTitleKeywords,
} from './filters.mjs';

async function mapLimit(items, limit, worker) {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('provider concurrency must be a positive integer');
  }
  const results = new Array(items.length);
  let next = 0;

  async function consume() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      () => consume(),
    ),
  );
  return results;
}

function validHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function inferRemoteType(rawLocation) {
  const text = String(rawLocation ?? '').toLowerCase();
  if (/\bhybrid\b/.test(text)) return 'Hybrid';
  if (/\bremote\b|\bworldwide\b|\banywhere\b/.test(text)) return 'Remote';
  if (/\bon[- ]?site\b|\boffice[- ]?based\b/.test(text)) return 'On-site';
  return 'Unknown';
}

function normalizePostedAt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

export function candidateFromJob(job, target, upstreamRef) {
  const postedAtUtc = normalizePostedAt(job.postedAt);
  const description = typeof job.description === 'string'
    ? job.description.trim()
    : '';

  return {
    schemaVersion: 1,
    sourceMode: target.targetClass === 'normal' ? 'catalog' : 'priority',
    sourceProvider: target.provider,
    sourceCompany: target.name,
    url: String(job.url ?? '').trim(),
    applyUrl: String(job.url ?? '').trim(),
    title: String(job.title ?? '').trim(),
    hiringCompanyName: String(job.company ?? target.name ?? '').trim(),
    postingCompanyName: null,
    foundOn: 'career-ops-scan',
    rawLocation: String(job.location ?? '').trim(),
    locations: [],
    remoteType: inferRemoteType(job.location),
    description,
    descriptionStatus: description ? 'provider-list' : 'missing',
    postedAtUtc,
    salary: job.salary ?? null,
    canonicalIdentity: null,
    existingJobId: null,
    preflight: null,
    provenance: {
      derivedFrom: 'santifer/career-ops',
      upstreamRef,
      providerNativeId: job.id != null ? String(job.id) : null,
      targetReason: target.reason,
      catalog: target.catalog ?? null,
    },
  };
}

function reject(reason, candidate = null, details = null) {
  return { reason, candidate, details };
}

function errorChain(error) {
  const values = [];
  let current = error;
  const seen = new Set();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    values.push(current);
    current = current.cause;
  }
  return values;
}

export function classifyProviderError(error) {
  const chain = errorChain(error);
  if (chain.some((item) => item.name === 'AbortError')) return 'timeout';

  const codes = chain
    .map((item) => item.code)
    .filter((value) => typeof value === 'string');
  if (codes.includes('ETIMEDOUT')) return 'timeout';

  const status = chain
    .map((item) => Number(
      item.status
      ?? item.statusCode
      ?? item.response?.status,
    ))
    .find((value) => Number.isInteger(value));

  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'http_4xx';
  if (status >= 500) return 'http_5xx';

  const networkCodes = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
  ]);
  if (codes.some((code) => networkCodes.has(code))) return 'network';
  if (chain.some(
    (item) => item instanceof TypeError
      && /fetch failed|network|socket|connection/i.test(item.message),
  )) return 'network';

  return 'provider_error';
}

function errorMessage(error, maxLength = 500) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= maxLength
    ? message
    : `${message.slice(0, maxLength - 3)}...`;
}

export async function runTrackedScan({
  portalConfig,
  targets,
  providers,
  concurrency,
  maxCandidates,
  upstreamRef,
  nowMs = Date.now(),
  monotonicNow = () => performance.now(),
  httpContextFactory = makeHttpCtx,
}) {
  if (!portalConfig || typeof portalConfig !== 'object' || Array.isArray(portalConfig)) {
    throw new Error('portalConfig must be an object');
  }
  if (!Array.isArray(targets)) {
    throw new Error('targets must be an array');
  }
  if (!(providers instanceof Map)) {
    throw new Error('providers must be a Map');
  }
  if (!Number.isInteger(maxCandidates) || maxCandidates <= 0) {
    throw new Error('maxCandidates must be a positive integer');
  }

  const titleFilter = buildTitleFilter(portalConfig.title_filter);
  const locationFilter = buildLocationFilter(portalConfig.location_filter);
  const postingAgeFilter = buildPostingAgeFilter(
    portalConfig.max_posting_age_days,
    nowMs,
  );
  const salaryFilter = buildSalaryFilter(portalConfig.salary_filter);
  const contentFilter = buildContentFilter(portalConfig.content_filter);

  const maxAgeDays = Number(portalConfig.max_posting_age_days);
  const sinceMs = Number.isInteger(maxAgeDays) && maxAgeDays > 0
    ? nowMs - maxAgeDays * 86_400_000
    : undefined;
  const httpContext = { ...httpContextFactory(), sinceMs };

  const batches = await mapLimit(targets, concurrency, async (target) => {
    const started = monotonicNow();
    try {
      const jobs = await target._provider.fetch(target, httpContext);
      if (!Array.isArray(jobs)) {
        const error = new Error('Provider returned a non-array job list');
        error.code = 'INVALID_PROVIDER_RESULT';
        throw error;
      }
      return {
        target,
        jobs,
        error: null,
        durationMs: Math.max(0, Math.round(monotonicNow() - started)),
      };
    } catch (error) {
      return {
        target,
        jobs: [],
        error,
        durationMs: Math.max(0, Math.round(monotonicNow() - started)),
      };
    }
  });

  const providerResults = batches.map((batch) => ({
    sequence: batch.target.sequence,
    provider: batch.target.provider,
    tenant: batch.target.tenant,
    targetClass: batch.target.targetClass,
    status: batch.error ? 'error' : 'ok',
    errorClass: batch.error ? classifyProviderError(batch.error) : null,
    errorMessage: batch.error ? errorMessage(batch.error) : null,
    jobsReturned: batch.jobs.length,
    candidatesRetained: 0,
    durationMs: batch.durationMs,
  }));
  const resultBySequence = new Map(
    providerResults.map((result) => [result.sequence, result]),
  );

  const candidates = [];
  const rejected = [];
  const seenUrls = new Set();

  outer:
  for (const batch of batches) {
    if (batch.error) {
      rejected.push(reject('provider_fetch_failed', null, {
        company: batch.target.name,
        provider: batch.target.provider,
        tenant: batch.target.tenant,
        errorClass: classifyProviderError(batch.error),
        error: errorMessage(batch.error),
      }));
      continue;
    }

    for (const job of batch.jobs) {
      const candidate = candidateFromJob(job, batch.target, upstreamRef);
      if (!candidate.title) {
        rejected.push(reject('missing_title', candidate));
        continue;
      }
      if (!candidate.hiringCompanyName) {
        rejected.push(reject('missing_company', candidate));
        continue;
      }
      if (!validHttpUrl(candidate.url)) {
        rejected.push(reject('missing_or_invalid_url', candidate));
        continue;
      }
      if (seenUrls.has(candidate.url)) {
        rejected.push(reject('duplicate_url_in_run', candidate));
        continue;
      }
      seenUrls.add(candidate.url);
      if (!titleFilter(candidate.title)) {
        rejected.push(reject('title_filter', candidate));
        continue;
      }
      if (!locationFilter(candidate.rawLocation)) {
        rejected.push(reject('location_filter', candidate));
        continue;
      }
      const postedAt = candidate.postedAtUtc
        ? Date.parse(candidate.postedAtUtc)
        : undefined;
      if (!postingAgeFilter(postedAt)) {
        rejected.push(reject('posting_age_filter', candidate));
        continue;
      }
      if (!salaryFilter(candidate.salary)) {
        rejected.push(reject('salary_filter', candidate));
        continue;
      }
      const matched = matchedTitleKeywords(
        candidate.title,
        portalConfig.title_filter,
      );
      if (!contentFilter(candidate.description, matched)) {
        rejected.push(reject('content_filter', candidate));
        continue;
      }

      candidates.push(candidate);
      const providerResult = resultBySequence.get(batch.target.sequence);
      providerResult.candidatesRetained += 1;
      if (candidates.length >= maxCandidates) break outer;
    }
  }

  return {
    candidates,
    rejected,
    targetCount: targets.length,
    providerIds: [...providers.keys()].sort(),
    providerResults,
  };
}
