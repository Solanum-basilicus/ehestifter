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
    const location = row.location && typeof row.location === 'object'
      ? row.location
      : {};
    jobs.push({
      id,
      title,
      url: `${origin}/careers/${encodeURIComponent(id)}`,
      company: companyName,
      location: [location.city, location.state, row.isRemote ? 'Remote' : '']
        .filter((value) => typeof value === 'string' && value.trim() !== '')
        .map((value) => value.trim())
        .join(', '),
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
