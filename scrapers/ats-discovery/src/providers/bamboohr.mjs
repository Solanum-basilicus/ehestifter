// Portions adapted from santifer/career-ops providers/bamboohr.mjs.
// Upstream ref: b9cd65e8ddba9448c9590c25f45288cf61c1c1c7 (MIT).

import { providerSourceMeta } from './_source-meta.mjs';

const BAMBOOHR_HOST_RE = /^[a-z0-9][a-z0-9-]*\.bamboohr\.com$/;

export const sourceMeta = providerSourceMeta({
  file: 'providers/bamboohr.mjs',
  ref: 'b9cd65e8ddba9448c9590c25f45288cf61c1c1c7',
  changes: [
    'explicit tenant() and sourceOrigin() contracts for Ehestifter planning',
    'provider capabilities for the shared detail stage',
    'stable provider-native job ids for canonical identity and canary detail checks',
    'ATS location fallback and explicit BambooHR work-arrangement extraction',
  ],
});

export function resolveBambooHROrigin(entry) {
  for (const raw of [entry.api, entry.careers_url]) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    let parsed;
    try {
      parsed = new URL(raw.trim());
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:' || !BAMBOOHR_HOST_RE.test(parsed.hostname)) {
      continue;
    }
    return `https://${parsed.hostname.toLowerCase()}`;
  }
  return null;
}

function cleanBambooHRText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function bambooHRRemoteType(job) {
  const locationType = String(job?.locationType ?? '').trim();
  if (locationType === '0') return 'On-Site';
  if (locationType === '1') return 'Remote';
  if (locationType === '2') return 'Hybrid';
  return job?.isRemote === true ? 'Remote' : null;
}

export function bambooHRStructuredLocation(job) {
  const primary = job?.location && typeof job.location === 'object' && !Array.isArray(job.location)
    ? job.location
    : null;
  const ats = job?.atsLocation && typeof job.atsLocation === 'object' && !Array.isArray(job.atsLocation)
    ? job.atsLocation
    : null;

  const source = primary && [
    primary.city,
    primary.state,
    primary.province,
    primary.addressCountry,
    primary.country,
  ].some((value) => cleanBambooHRText(value) !== '')
    ? primary
    : ats;
  if (!source) return null;

  const location = {
    countryName: cleanBambooHRText(source.addressCountry ?? source.country) || null,
    countryCode: cleanBambooHRText(source.countryCode ?? source.alpha2Code) || null,
    cityName: cleanBambooHRText(source.city) || null,
    region: cleanBambooHRText(source.state ?? source.province) || null,
  };
  return Object.values(location).some(Boolean) ? location : null;
}

export function bambooHRLocationText(job) {
  const location = bambooHRStructuredLocation(job);
  const remoteType = bambooHRRemoteType(job);
  return [
    location?.cityName,
    location?.region,
    location?.countryName ?? location?.countryCode,
    remoteType,
  ].filter(Boolean).join(', ');
}

export function parseBambooHRResponse(json, companyName, origin) {
  const rows = json?.result;
  if (!Array.isArray(rows)) return [];
  const jobs = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.id ?? '').trim();
    const title = String(row.jobOpeningName ?? '').trim();
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    jobs.push({
      id,
      title,
      url: `${origin}/careers/${encodeURIComponent(id)}`,
      company: companyName,
      location: bambooHRLocationText(row),
    });
  }
  return jobs;
}

export default {
  id: 'bamboohr',
  source: sourceMeta,
  capabilities: Object.freeze({
    listDescription: false,
    detail: true,
    importReady: true,
    providerDateFilter: false,
  }),
  detect(entry) {
    const origin = resolveBambooHROrigin(entry);
    return origin ? { url: `${origin}/careers/list` } : null;
  },
  tenant(entry) {
    const origin = resolveBambooHROrigin(entry);
    return origin ? new URL(origin).hostname.split('.')[0] : null;
  },
  sourceOrigin(entry) {
    return resolveBambooHROrigin(entry);
  },
  async fetch(entry, ctx) {
    const origin = resolveBambooHROrigin(entry);
    if (!origin) throw new Error(`bamboohr: cannot resolve tenant for ${entry.name}`);
    const json = await ctx.fetchJson(`${origin}/careers/list`, {
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
    return parseBambooHRResponse(json, entry.name, origin);
  },
};
