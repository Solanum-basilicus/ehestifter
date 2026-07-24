// Portions adapted from santifer/career-ops providers/smartrecruiters.mjs.
// Upstream ref: 4624242367056d7c118249279c80b8bb8da62b04 (MIT).

import { providerSourceMeta } from './_source-meta.mjs';

const API_HOST = 'api.smartrecruiters.com';
const CAREERS_HOSTS = new Set([
  'careers.smartrecruiters.com',
  'jobs.smartrecruiters.com',
]);
const PAGE_SIZE = 100;
const HARD_MAX_PAGES = 50;

export const sourceMeta = providerSourceMeta({
  file: 'providers/smartrecruiters.mjs',
  ref: '4624242367056d7c118249279c80b8bb8da62b04',
  changes: [
    'tenant-aware fallback URLs instead of company-name slugging',
    'releasedDate mapping and explicit page cap integration',
    'explicit tenant() contract and provider capabilities',
  ],
});

export function resolveSmartRecruitersTenant(entry) {
  for (const raw of [entry.api, entry.careers_url]) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:' || !CAREERS_HOSTS.has(parsed.hostname)) {
      continue;
    }
    const tenant = parsed.pathname.split('/').filter(Boolean)[0];
    if (/^[A-Za-z0-9._-]+$/.test(tenant ?? '')) return tenant;
  }
  return null;
}

function postingsUrl(tenant, offset) {
  const url = new URL(
    `https://${API_HOST}/v1/companies/${encodeURIComponent(tenant)}/postings`,
  );
  url.searchParams.set('limit', String(PAGE_SIZE));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('status', 'PUBLIC');
  return url;
}

function publicUrl(tenant, id, title) {
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `https://jobs.smartrecruiters.com/${encodeURIComponent(tenant)}`
    + `/${encodeURIComponent(id)}${slug ? `-${slug}` : ''}`;
}

function validRef(ref) {
  if (typeof ref !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(ref);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== API_HOST) return null;
  const match = parsed.pathname.match(/^\/v1\/companies\/([^/]+)\/postings\/([^/]+)$/);
  if (!match) return null;
  return {
    tenant: decodeURIComponent(match[1]),
    id: decodeURIComponent(match[2]),
  };
}

function postedAt(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function parseSmartRecruitersResponse(json, companyName, tenant) {
  const items = Array.isArray(json?.content) ? json.content : [];
  const jobs = [];
  for (const item of items) {
    const id = item?.id == null ? '' : String(item.id);
    const title = typeof item?.name === 'string' ? item.name.trim() : '';
    if (!id || !title) continue;
    const locationObject = item.location ?? {};
    const baseLocation = typeof locationObject.fullLocation === 'string'
      ? locationObject.fullLocation.trim()
      : [
        locationObject.city,
        locationObject.region,
        locationObject.country,
      ].filter(Boolean).join(', ');
    const location = [baseLocation, locationObject.remote ? 'Remote' : '']
      .filter(Boolean)
      .join(', ');
    const ref = validRef(item.ref);
    const canonicalTenant = ref?.tenant || tenant;
    const canonicalId = ref?.id || id;
    const job = {
      id: canonicalId,
      title,
      url: publicUrl(canonicalTenant, canonicalId, title),
      company: companyName,
      location,
    };
    const release = postedAt(item.releasedDate || item.createdOn);
    if (release !== undefined) job.postedAt = release;
    jobs.push(job);
  }
  return jobs;
}

function maxPages(entry, ctx) {
  const configured = Number.isInteger(entry.max_pages) && entry.max_pages > 0
    ? entry.max_pages
    : HARD_MAX_PAGES;
  const contextLimit = Number.isInteger(ctx.maxPages) && ctx.maxPages > 0
    ? ctx.maxPages
    : HARD_MAX_PAGES;
  return Math.min(configured, contextLimit, HARD_MAX_PAGES);
}

export default {
  id: 'smartrecruiters',
  source: sourceMeta,
  capabilities: Object.freeze({
    listDescription: false,
    detail: true,
    importReady: true,
    providerDateFilter: false,
  }),
  detect(entry) {
    const tenant = resolveSmartRecruitersTenant(entry);
    return tenant ? { url: postingsUrl(tenant, 0).href } : null;
  },
  tenant(entry) {
    return resolveSmartRecruitersTenant(entry);
  },
  sourceOrigin(entry) {
    const tenant = resolveSmartRecruitersTenant(entry);
    return tenant ? 'https://jobs.smartrecruiters.com' : null;
  },
  async fetch(entry, ctx) {
    const tenant = resolveSmartRecruitersTenant(entry);
    if (!tenant) {
      throw new Error(`smartrecruiters: cannot resolve tenant for ${entry.name}`);
    }
    const jobs = [];
    const seen = new Set();
    for (let page = 0; page < maxPages(entry, ctx); page += 1) {
      const json = await ctx.fetchJson(postingsUrl(tenant, page * PAGE_SIZE), {
        redirect: 'error',
        headers: { accept: 'application/json' },
      });
      const rawCount = Array.isArray(json?.content) ? json.content.length : 0;
      if (rawCount === 0) break;
      for (const job of parseSmartRecruitersResponse(json, entry.name, tenant)) {
        if (seen.has(job.id)) continue;
        seen.add(job.id);
        jobs.push(job);
      }
      if (rawCount < PAGE_SIZE) break;
    }
    return jobs;
  },
};
