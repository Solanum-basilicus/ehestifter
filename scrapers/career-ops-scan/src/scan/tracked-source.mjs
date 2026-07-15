import { readFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { makeHttpCtx } from '../providers/_http.mjs';
import { loadProviders, resolveProvider } from '../providers/_registry.mjs';
import {
  buildContentFilter,
  buildLocationFilter,
  buildPostingAgeFilter,
  buildSalaryFilter,
  buildTitleFilter,
  matchedTitleKeywords,
} from './filters.mjs';

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function consume() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
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

function candidateFromJob(job, target, upstreamRef) {
  const postedAtUtc = typeof job.postedAt === 'number' && Number.isFinite(job.postedAt)
    ? new Date(job.postedAt).toISOString()
    : null;
  const description = typeof job.description === 'string' ? job.description.trim() : '';
  return {
    schemaVersion: 1,
    sourceMode: 'tracked',
    sourceProvider: target._provider.id,
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
    },
  };
}

function reject(reason, candidate = null, details = null) {
  return { reason, candidate, details };
}

export async function runTrackedScan({ portalsPath, providersDir, concurrency, maxCandidates, upstreamRef }) {
  const rawConfig = yaml.load(await readFile(portalsPath, 'utf8')) ?? {};
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new Error('portals.yml root must be an object');
  }

  const providers = await loadProviders(path.resolve(providersDir));
  if (providers.size === 0) throw new Error(`No providers loaded from ${providersDir}`);

  const titleFilter = buildTitleFilter(rawConfig.title_filter);
  const locationFilter = buildLocationFilter(rawConfig.location_filter);
  const postingAgeFilter = buildPostingAgeFilter(rawConfig.max_posting_age_days);
  const salaryFilter = buildSalaryFilter(rawConfig.salary_filter);
  const contentFilter = buildContentFilter(rawConfig.content_filter);

  const targets = [];
  const rejected = [];
  for (const entry of Array.isArray(rawConfig.tracked_companies) ? rawConfig.tracked_companies : []) {
    if (!entry || typeof entry !== 'object' || entry.enabled === false) continue;
    if (typeof entry.name !== 'string' || !entry.name.trim()) {
      rejected.push(reject('invalid_portal_entry', null, { entry }));
      continue;
    }
    const resolved = resolveProvider(entry, providers);
    if (!resolved) {
      rejected.push(reject('provider_not_resolved', null, { company: entry.name }));
      continue;
    }
    if (resolved.error) {
      rejected.push(reject('provider_resolution_error', null, {
        company: entry.name,
        error: resolved.error,
      }));
      continue;
    }
    targets.push({ ...entry, _provider: resolved.provider });
  }

  const maxAgeDays = Number(rawConfig.max_posting_age_days);
  const sinceMs = Number.isInteger(maxAgeDays) && maxAgeDays > 0
    ? Date.now() - maxAgeDays * 86_400_000
    : undefined;
  const httpContext = { ...makeHttpCtx(), sinceMs };

  const batches = await mapLimit(targets, concurrency, async (target) => {
    try {
      const jobs = await target._provider.fetch(target, httpContext);
      return { target, jobs: Array.isArray(jobs) ? jobs : [], error: null };
    } catch (error) {
      return { target, jobs: [], error: error instanceof Error ? error.message : String(error) };
    }
  });

  const candidates = [];
  const seenUrls = new Set();

  outer:
  for (const batch of batches) {
    if (batch.error) {
      rejected.push(reject('provider_fetch_failed', null, {
        company: batch.target.name,
        provider: batch.target._provider.id,
        error: batch.error,
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
      const postedAt = candidate.postedAtUtc ? Date.parse(candidate.postedAtUtc) : undefined;
      if (!postingAgeFilter(postedAt)) {
        rejected.push(reject('posting_age_filter', candidate));
        continue;
      }
      if (!salaryFilter(candidate.salary)) {
        rejected.push(reject('salary_filter', candidate));
        continue;
      }
      const matched = matchedTitleKeywords(candidate.title, rawConfig.title_filter);
      if (!contentFilter(candidate.description, matched)) {
        rejected.push(reject('content_filter', candidate));
        continue;
      }
      candidates.push(candidate);
      if (candidates.length >= maxCandidates) break outer;
    }
  }

  return {
    candidates,
    rejected,
    targetCount: targets.length,
    providerIds: [...providers.keys()].sort(),
  };
}
