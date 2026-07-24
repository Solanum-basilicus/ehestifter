import { makeHttpCtx } from '../providers/_http.mjs';
import {
  buildContentFilter,
  buildLocationFilter,
  buildPostingAgeFilter,
  buildSalaryFilter,
  buildTitleEvaluator,
  matchedTitleKeywords,
} from './filters.mjs';
import { executeProviderTargets } from './provider-executor.mjs';
import { buildLocationScopeFilter } from './location-scope.mjs';
import {
  classifyProviderError,
  providerErrorMessage,
} from './provider-errors.mjs';

export { classifyProviderError } from './provider-errors.mjs';

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

function sourceOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function providerImplementationRef(provider) {
  const source = provider?.source;
  if (!source || typeof source !== 'object') return null;
  return {
    repository: source.repository ?? null,
    file: source.file ?? null,
    ref: source.ref ?? null,
    license: source.license ?? null,
  };
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
    sourceProviderVariant: target.providerVariant ?? null,
    sourceTenant: target.tenant,
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
      sourceOrigin: target.sourceOrigin || sourceOrigin(target.careers_url),
      providerImplementation: providerImplementationRef(target._provider),
      acquisitionMode: typeof job.acquisitionMode === 'string'
        ? job.acquisitionMode
        : null,
      healthPartition: target.healthPartition ?? target.provider,
      targetSequence: target.sequence,
      targetReason: target.reason,
      catalog: target.catalog ?? null,
      lookbackStartUtc: target.lookbackStartUtc ?? null,
    },
  };
}

function reject(reason, candidate = null, details = null) {
  return { reason, candidate, details };
}

function targetSinceMs(target, portalConfig, nowMs) {
  if (target.lookbackUnbounded === true) return undefined;
  if (typeof target.lookbackStartUtc === 'string') {
    const parsed = Date.parse(target.lookbackStartUtc);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const maxAgeDays = Number(portalConfig.max_posting_age_days);
  return Number.isInteger(maxAgeDays) && maxAgeDays > 0
    ? nowMs - maxAgeDays * 86_400_000
    : undefined;
}

export async function runTrackedScan({
  portalConfig,
  targets,
  providers,
  policy,
  concurrency,
  maxCandidates,
  upstreamRef,
  nowMs = Date.now(),
  monotonicNow,
  sleep,
  httpContextFactory = makeHttpCtx,
  onProgress = null,
}) {
  if (!portalConfig || typeof portalConfig !== 'object' || Array.isArray(portalConfig)) {
    throw new Error('portalConfig must be an object');
  }
  if (!Array.isArray(targets)) throw new Error('targets must be an array');
  if (!(providers instanceof Map)) throw new Error('providers must be a Map');
  if (!policy || policy.schemaVersion !== 1) {
    throw new Error('parsed discovery policy is required');
  }
  if (!Number.isInteger(maxCandidates) || maxCandidates <= 0) {
    throw new Error('maxCandidates must be a positive integer');
  }

  const titleEvaluator = buildTitleEvaluator(portalConfig.title_filter);
  const locationFilter = buildLocationFilter(portalConfig.location_filter);
  const locationScopeFilter = buildLocationScopeFilter(
    portalConfig.location_scope_filter,
  );
  const postingAgeFilter = buildPostingAgeFilter(
    portalConfig.max_posting_age_days,
    nowMs,
  );
  const salaryFilter = buildSalaryFilter(portalConfig.salary_filter);
  const contentFilter = buildContentFilter(portalConfig.content_filter);

  const execution = await executeProviderTargets({
    targets,
    policy,
    globalConcurrency: concurrency,
    monotonicNow,
    sleep,
    onProgress,
    fetchTarget: async (target) => {
      const sinceMs = targetSinceMs(target, portalConfig, nowMs);
      let telemetry = {};
      const httpContext = {
        ...httpContextFactory(),
        sinceMs,
        reportProviderTelemetry(value) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return;
          telemetry = { ...telemetry, ...value };
        },
      };
      try {
        const jobs = await target._provider.fetch(target, httpContext);
        return { jobs, providerTelemetry: telemetry };
      } catch (error) {
        if (error && typeof error === 'object') {
          error.providerTelemetry = { ...telemetry, ...(error.providerTelemetry ?? {}) };
        }
        throw error;
      }
    },
  });

  const providerResults = execution.batches.map((batch) => batch.providerResult);
  const resultBySequence = new Map(
    providerResults.map((result) => [result.sequence, result]),
  );
  const candidates = [];
  const canaryCandidates = [];
  const rejected = [];
  const seenUrls = new Set();

  for (const batch of execution.batches) {
    if (batch.providerResult.status === 'skipped') continue;

    if (batch.target.canary != null && batch.jobs.length > 0) {
      const sampleSize = batch.target.canary.detailSampleSize ?? 0;
      for (const job of batch.jobs.slice(0, sampleSize)) {
        const candidate = candidateFromJob(job, batch.target, upstreamRef);
        if (!candidate.title || !candidate.hiringCompanyName || !validHttpUrl(candidate.url)) {
          continue;
        }
        canaryCandidates.push({
          ...candidate,
          preflight: { status: 'ok', exists: false, source: 'provider_canary' },
          canary: {
            minimumJobs: batch.target.canary.minimumJobs ?? 1,
            minimumDetailSuccesses:
              batch.target.canary.minimumDetailSuccesses ?? 0,
          },
        });
      }
    }

    if (batch.target.healthOnly) {
      if (batch.error && batch.jobs.length === 0) {
        rejected.push(reject('provider_fetch_failed', null, {
          company: batch.target.name,
          provider: batch.target.provider,
          providerVariant: batch.target.providerVariant ?? null,
          healthPartition: batch.target.healthPartition ?? batch.target.provider,
          tenant: batch.target.tenant,
          errorClass: batch.providerResult.errorClass,
          httpStatus: batch.providerResult.httpStatus,
          error: providerErrorMessage(batch.error),
        }));
      }
      continue;
    }

    if (batch.error && batch.jobs.length === 0) {
      rejected.push(reject('provider_fetch_failed', null, {
        company: batch.target.name,
        provider: batch.target.provider,
        providerVariant: batch.target.providerVariant ?? null,
        healthPartition: batch.target.healthPartition ?? batch.target.provider,
        tenant: batch.target.tenant,
        errorClass: batch.providerResult.errorClass,
        httpStatus: batch.providerResult.httpStatus,
        error: providerErrorMessage(batch.error),
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
      const titleEvaluation = titleEvaluator(candidate.title);
      if (!titleEvaluation.allowed) {
        rejected.push(reject('title_filter', candidate, {
          positiveMatches: titleEvaluation.positiveMatches,
          negativeMatches: titleEvaluation.negativeMatches,
        }));
        continue;
      }
      const locationScope = locationScopeFilter(candidate.rawLocation);
      if (!locationScope.allowed) {
        rejected.push(reject('location_scope_filter', candidate, {
          reason: locationScope.reason,
          allowedMatches: locationScope.allowedMatches,
          blockedMatches: locationScope.blockedMatches,
          markerMatches: locationScope.markerMatches ?? [],
        }));
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

      const providerResult = resultBySequence.get(batch.target.sequence);
      providerResult.candidatesMatched += 1;
      if (candidates.length < maxCandidates) {
        candidates.push(candidate);
        providerResult.candidatesRetained += 1;
      } else {
        providerResult.candidatesDroppedByCap += 1;
        rejected.push(reject('candidate_cap', null, {
          provider: batch.target.provider,
          tenant: batch.target.tenant,
          url: candidate.url,
        }));
      }
    }
  }

  return {
    candidates,
    canaryCandidates,
    rejected,
    targetCount: targets.length,
    providerIds: [...providers.keys()].sort(),
    providerResults,
    breakerEvents: execution.breakerEvents,
  };
}
