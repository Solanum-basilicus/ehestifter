import { makeHttpCtx } from '../providers/_http.mjs';
import { getProviderPolicy } from '../policy/discovery-policy.mjs';
import {
  buildContentFilter,
  buildLocationFilter,
  buildPostingAgeFilter,
  buildSalaryFilter,
  buildTitleEvaluator,
  matchedTitleKeywords,
} from './filters.mjs';
import { executeProviderTargets } from './provider-executor.mjs';
import { normalizeNoBreakWhitespace } from '../text/html.mjs';
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
    ? normalizeNoBreakWhitespace(job.description).trim()
    : '';

  const providerSource = target._provider?.source;
  let explicitIdentity = null;
  if (
    target._provider?.capabilities?.explicitIdentityPreflight === true
    && job.id != null
    && String(job.id).trim() !== ''
  ) {
    const supplied = job.explicitIdentity;
    if (supplied != null) {
      const provider = typeof supplied.provider === 'string' ? supplied.provider.trim() : '';
      const providerTenant = typeof supplied.providerTenant === 'string'
        ? supplied.providerTenant.trim()
        : '';
      const externalId = typeof supplied.externalId === 'string'
        ? supplied.externalId.trim()
        : '';
      if (provider !== target.provider || !providerTenant || externalId !== String(job.id).trim()) {
        throw new Error(`Provider ${target.provider} returned an invalid explicit job identity`);
      }
      explicitIdentity = { provider, providerTenant, externalId };
    } else {
      explicitIdentity = {
        provider: target.provider,
        providerTenant: target.tenant,
        externalId: String(job.id).trim(),
      };
    }
  }

  const jobUrl = String(job.url ?? '').trim();
  const applyUrl = String(job.applyUrl ?? '').trim();

  return {
    schemaVersion: 1,
    sourceMode: target.targetClass === 'normal' ? 'catalog' : 'priority',
    sourceProvider: target.provider,
    sourceProviderVariant: target.providerVariant ?? null,
    sourceTenant: target.tenant,
    sourceCompany: target.name,
    url: jobUrl,
    applyUrl: validHttpUrl(applyUrl) ? applyUrl : jobUrl,
    title: String(job.title ?? '').trim(),
    hiringCompanyName: String(job.company ?? target.name ?? '').trim(),
    postingCompanyName: null,
    foundOn: 'ats-discovery',
    rawLocation: String(job.location ?? '').trim(),
    locations: [],
    remoteType: inferRemoteType(job.location),
    description,
    descriptionStatus: description ? 'provider-list' : 'missing',
    postedAtUtc,
    salary: job.salary ?? null,
    canonicalIdentity: null,
    explicitIdentity,
    existingJobId: null,
    preflight: null,
    provenance: {
      derivedFrom: providerSource?.repository ?? 'santifer/career-ops',
      upstreamRef: providerSource?.repository === 'santifer/career-ops'
        ? upstreamRef
        : null,
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


function buildAdmissionStats(candidates, titleMatchesBeforePreliminary, userCounts, userSources) {
  const users = [...userCounts.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([userId, titleCandidatesMatched]) => {
      const matches = candidates.filter((candidate) => (candidate.matchedUserIds ?? []).includes(userId));
      return {
        userId,
        titleCandidatesMatched,
        priorityTitleCandidatesMatched: userSources.get(userId)?.priority ?? 0,
        catalogTitleCandidatesMatched: userSources.get(userId)?.catalog ?? 0,
        candidatesRetainedByCap: matches.length,
        candidatesDroppedByCap: 0,
      };
    });
  return {
    titleMatchedCandidatesBeforeCap: titleMatchesBeforePreliminary,
    userCandidateMatchesBeforeCap: [...userCounts.values()].reduce((sum, count) => sum + count, 0),
    candidatesRetained: candidates.length,
    candidatesDroppedByCap: 0,
    usersAffectedByCandidateCap: 0,
    usersStarvedByCandidateCap: 0,
    candidateCapReached: false,
    users,
  };
}

export async function runTrackedScan({
  portalConfig,
  targets,
  providers,
  policy,
  concurrency,
  upstreamRef,
  nowMs = Date.now(),
  monotonicNow,
  sleep,
  httpContextFactory = makeHttpCtx,
  onProgress = null,
  onProviderResult = null,
  onRejected = null,
  retainRejected = true,
  candidateMatcher = null,
  applyPortalCandidateFilters = true,
  preliminaryEvaluator = null,
}) {
  if (!portalConfig || typeof portalConfig !== 'object' || Array.isArray(portalConfig)) {
    throw new Error('portalConfig must be an object');
  }
  if (!Array.isArray(targets)) throw new Error('targets must be an array');
  if (!(providers instanceof Map)) throw new Error('providers must be a Map');
  if (!policy || policy.schemaVersion !== 1) {
    throw new Error('parsed discovery policy is required');
  }
  if (preliminaryEvaluator != null && typeof preliminaryEvaluator !== 'function') {
    throw new Error('preliminaryEvaluator must be a function');
  }
  if (typeof applyPortalCandidateFilters !== 'boolean') {
    throw new Error('applyPortalCandidateFilters must be a boolean');
  }
  if (onRejected != null && typeof onRejected !== 'function') {
    throw new Error('onRejected must be a function');
  }
  if (onProviderResult != null && typeof onProviderResult !== 'function') {
    throw new Error('onProviderResult must be a function');
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
    onResult: onProviderResult,
    fetchTarget: async (target) => {
      const sinceMs = targetSinceMs(target, portalConfig, nowMs);
      let telemetry = {};
      const httpContext = {
        ...httpContextFactory(),
        sinceMs,
        providerMinRequestIntervalMs: getProviderPolicy(
          policy,
          target._provider.id,
        ).execution.minRequestIntervalMs,
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
  const rejectionCounts = {};
  let rejectedCount = 0;
  const seenUrls = new Set();
  const preliminaryCounts = { matched: 0, unknown: 0, mismatch: 0 };
  const preliminarySample = [];
  const preliminarySampleCounts = { matched: 0, unknown: 0, mismatch: 0 };
  const preliminaryWarnings = new Map();
  const preliminaryUserTitleCounts = new Map();
  const preliminaryUserSourceCounts = new Map();
  let titleMatchesBeforePreliminary = 0;
  let preliminaryRejected = 0;

  async function emitRejected(items) {
    if (items.length === 0) return;
    rejectedCount += items.length;
    for (const item of items) {
      const reason = item?.reason ?? 'unknown';
      rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1;
    }
    if (retainRejected) rejected.push(...items);
    if (onRejected) await onRejected(items);
  }

  for (const batch of execution.batches) {
    const batchRejected = [];
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
        batchRejected.push(reject('provider_fetch_failed', null, {
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
      await emitRejected(batchRejected);
      continue;
    }

    if (batch.error && batch.jobs.length === 0) {
      batchRejected.push(reject('provider_fetch_failed', null, {
        company: batch.target.name,
        provider: batch.target.provider,
        providerVariant: batch.target.providerVariant ?? null,
        healthPartition: batch.target.healthPartition ?? batch.target.provider,
        tenant: batch.target.tenant,
        errorClass: batch.providerResult.errorClass,
        httpStatus: batch.providerResult.httpStatus,
        error: providerErrorMessage(batch.error),
      }));
      await emitRejected(batchRejected);
      continue;
    }

    for (const job of batch.jobs) {
      let candidate = candidateFromJob(job, batch.target, upstreamRef);
      if (!candidate.title) {
        batchRejected.push(reject('missing_title', candidate));
        continue;
      }
      if (!candidate.hiringCompanyName) {
        batchRejected.push(reject('missing_company', candidate));
        continue;
      }
      if (!validHttpUrl(candidate.url)) {
        batchRejected.push(reject('missing_or_invalid_url', candidate));
        continue;
      }
      if (seenUrls.has(candidate.url)) {
        batchRejected.push(reject('duplicate_url_in_run', candidate));
        continue;
      }
      seenUrls.add(candidate.url);
      let titleEvaluation = {
        allowed: true,
        positiveMatches: [],
        negativeMatches: [],
      };
      if (applyPortalCandidateFilters) {
        titleEvaluation = titleEvaluator(candidate.title);
        if (!titleEvaluation.allowed) {
          batchRejected.push(reject('title_filter', candidate, {
            positiveMatches: titleEvaluation.positiveMatches,
            negativeMatches: titleEvaluation.negativeMatches,
          }));
          continue;
        }
      }
      if (applyPortalCandidateFilters) {
        const locationScope = locationScopeFilter(candidate.rawLocation);
        if (!locationScope.allowed) {
          batchRejected.push(reject('location_scope_filter', candidate, {
            reason: locationScope.reason,
            allowedMatches: locationScope.allowedMatches,
            blockedMatches: locationScope.blockedMatches,
            markerMatches: locationScope.markerMatches ?? [],
          }));
          continue;
        }
      }
      if (applyPortalCandidateFilters && !locationFilter(candidate.rawLocation)) {
        batchRejected.push(reject('location_filter', candidate));
        continue;
      }
      const postedAt = candidate.postedAtUtc
        ? Date.parse(candidate.postedAtUtc)
        : undefined;
      if (!postingAgeFilter(postedAt)) {
        batchRejected.push(reject('posting_age_filter', candidate));
        continue;
      }
      if (applyPortalCandidateFilters && !salaryFilter(candidate.salary)) {
        batchRejected.push(reject('salary_filter', candidate));
        continue;
      }
      const matched = applyPortalCandidateFilters
        ? matchedTitleKeywords(candidate.title, portalConfig.title_filter)
        : [];
      if (
        applyPortalCandidateFilters
        && !contentFilter(candidate.description, matched)
      ) {
        batchRejected.push(reject('content_filter', candidate));
        continue;
      }
      if (candidateMatcher) {
        let userMatch;
        try {
          userMatch = candidateMatcher(candidate);
        } catch (error) {
          batchRejected.push(reject('user_match_error', candidate, {
            error: error instanceof Error ? error.message : String(error),
          }));
          continue;
        }
        if (!userMatch?.allowed) {
          batchRejected.push(reject('no_user_match', candidate));
          continue;
        }
        candidate.matchedUserIds = [...userMatch.matchedUserIds];
        candidate.userMatch = {
          matchedProfiles: Array.isArray(userMatch.matchedProfiles)
            ? userMatch.matchedProfiles
            : [],
          matchedTitles: Array.isArray(userMatch.matchedTitles)
            ? userMatch.matchedTitles
            : [],
        };
      }

      const providerResult = resultBySequence.get(batch.target.sequence);
      providerResult.candidatesMatched += 1;
      titleMatchesBeforePreliminary += 1;
      for (const userId of candidate.matchedUserIds ?? []) {
        preliminaryUserTitleCounts.set(userId, (preliminaryUserTitleCounts.get(userId) ?? 0) + 1);
        const sourceCounts = preliminaryUserSourceCounts.get(userId) ?? { priority: 0, catalog: 0 };
        sourceCounts[candidate.sourceMode] += 1;
        preliminaryUserSourceCounts.set(userId, sourceCounts);
      }
      if (preliminaryEvaluator) {
        // Run the safe listing-only check before later work and admission.
        const result = preliminaryEvaluator(candidate);
        candidate = result.candidate;
        const status = candidate.preliminaryGeography?.status ?? 'unknown';
        preliminaryCounts[status] = (preliminaryCounts[status] ?? 0) + 1;
        // Keep up to 20 examples per result class for bounded diagnostics.
        if ((preliminarySampleCounts[status] ?? 0) < 20) {
          preliminarySample.push(candidate);
          preliminarySampleCounts[status] = (preliminarySampleCounts[status] ?? 0) + 1;
        }
        for (const warning of result.warnings ?? []) {
          const key = JSON.stringify(warning);
          if (!preliminaryWarnings.has(key)) preliminaryWarnings.set(key, warning);
        }
        if (result.reject === true) {
          preliminaryRejected += 1;
          batchRejected.push(reject('no_user_location_match', candidate,
            result.rejectionDetails ?? {
              phase: 'preliminary',
              status: candidate.preliminaryGeography?.status ?? null,
            }));
          continue;
        }
      }
      providerResult.candidatesRetained += 1;
      candidates.push(candidate);
    }
    await emitRejected(batchRejected);
  }

  const admissionStats = buildAdmissionStats(
    candidates, titleMatchesBeforePreliminary, preliminaryUserTitleCounts,
    preliminaryUserSourceCounts,
  );

  return {
    candidates,
    candidateAdmission: admissionStats,
    preliminarySample,
    preliminaryDiscoveryEligibility: preliminaryEvaluator ? {
      counts: preliminaryCounts,
      warnings: [...preliminaryWarnings.values()],
      rejectedBeforeDetail: preliminaryRejected,
      candidatesBeforeCheck: titleMatchesBeforePreliminary,
      candidatesRetained: candidates.length,
      sampleCounts: preliminarySampleCounts,
    } : null,
    canaryCandidates,
    rejected,
    rejectedCount,
    rejectionCounts,
    targetCount: targets.length,
    providerIds: [...providers.keys()].sort(),
    providerResults,
    breakerEvents: execution.breakerEvents,
  };
}
