// Classic iCIMS listing logic is adapted from santifer/career-ops providers/icims.mjs.
// Jibe/iCIMS Career Sites API behavior is adapted from career-ops providers/jibeapply.mjs.
// Upstream refs: b9cd65e8ddba9448c9590c25f45288cf61c1c1c7 and 311ed4a (MIT).

import { BROWSER_LIKE_USER_AGENT } from './_http.mjs';
import { providerSourceMeta } from './_source-meta.mjs';
import { icimsVariant } from './_variant.mjs';
import { decodeHtmlEntities, htmlToPlainText } from '../text/html.mjs';

const ICIMS_HOST_RE = /^[a-z0-9][a-z0-9.-]*\.icims\.com$/;
const JIBE_HOST_RE = /^[a-z0-9][a-z0-9.-]*\.jibeapply\.com$/;
const CLASSIC_DEFAULT_MAX_PAGES = 30;
const CLASSIC_HARD_MAX_PAGES = 30;
const JIBE_DEFAULT_MAX_PAGES = 30;
const JIBE_HARD_MAX_PAGES = 50;
const JIBE_PAGE_SIZE = 100;
const INTER_PAGE_DELAY_MS = 150;
const CLASSIC_HEADERS = Object.freeze({
  accept: 'text/html,application/xhtml+xml',
  'user-agent': BROWSER_LIKE_USER_AGENT,
  'accept-language': 'en-US,en;q=0.9',
});
const JIBE_HEADERS = Object.freeze({
  accept: 'application/json',
  'user-agent': 'Ehestifter ATS Discovery',
});

export const sourceMeta = providerSourceMeta({
  file: 'providers/icims.mjs',
  ref: 'b9cd65e8ddba9448c9590c25f45288cf61c1c1c7',
  changes: [
    'classic portal bootstrap that follows the tenant-generated search entry URL',
    'bounded classic pagination that follows same-origin iCIMS page links',
    'AWS WAF CAPTCHA classification for blocked classic portals',
    'Jibe Career Sites public /api/jobs acquisition adapted from career-ops@311ed4a',
    'full descriptions and per-job iCIMS identity derived from Jibe apply_url',
    'full classic portal host as provider tenant to prevent cross-tenant id collisions',
  ],
});

function sleep(ms, ctx) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanHttpsUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || (parsed.port && parsed.port !== '443')
  ) return null;
  return parsed;
}

export function resolveIcimsOrigin(entry) {
  for (const raw of [entry.api, entry.careers_url]) {
    const parsed = cleanHttpsUrl(raw);
    if (!parsed) continue;
    const host = parsed.hostname.toLowerCase();
    if (!ICIMS_HOST_RE.test(host) || host === 'www.icims.com') continue;
    return `https://${host}`;
  }
  return null;
}

export function resolveJibeEndpoint(entry) {
  const careers = cleanHttpsUrl(entry?.careers_url);
  const api = cleanHttpsUrl(entry?.api);
  const origin = careers?.origin ?? api?.origin ?? null;
  if (!origin) return null;

  if (api) {
    if (
      api.origin !== origin
      || !/^\/api\/jobs\/?$/i.test(api.pathname)
      || api.search
      || api.hash
    ) return null;
    api.pathname = '/api/jobs';
    return { origin, apiUrl: api.href };
  }

  if (!careers) return null;
  if (icimsVariant(entry) !== 'jibe' && !JIBE_HOST_RE.test(careers.hostname)) return null;
  return { origin, apiUrl: new URL('/api/jobs', origin).href };
}

function introUrl(origin) {
  const url = new URL('/jobs/intro', origin);
  url.searchParams.set('mobile', 'true');
  url.searchParams.set('needsRedirect', 'false');
  return url.href;
}

function safeSearchPageUrl(rawHref, origin) {
  if (typeof rawHref !== 'string' || rawHref.trim() === '') return null;
  let parsed;
  try {
    parsed = new URL(decodeHtmlEntities(rawHref.trim()), origin);
  } catch {
    return null;
  }
  if (parsed.origin !== origin || !/^\/jobs\/search\/?$/i.test(parsed.pathname)) return null;
  parsed.hash = '';
  return parsed;
}

function anchorHrefs(html) {
  return [...String(html ?? '').matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => match[1]);
}

export function resolveIcimsSearchUrl(html, origin) {
  let fallback = null;
  for (const href of anchorHrefs(html)) {
    const parsed = safeSearchPageUrl(href, origin);
    if (!parsed) continue;
    if (!fallback) fallback = parsed.href;
    if (parsed.searchParams.get('ss') === '1') return parsed.href;
  }
  return fallback;
}

export function resolveIcimsNextPageUrl(html, origin, currentPage) {
  const expected = currentPage + 1;
  for (const href of anchorHrefs(html)) {
    const parsed = safeSearchPageUrl(href, origin);
    if (!parsed) continue;
    const page = Number.parseInt(parsed.searchParams.get('pr') ?? '', 10);
    if (page === expected) return parsed.href;
  }
  return null;
}

function maxPages(entry, ctx, { defaultLimit, hardLimit }) {
  const configured = Number.isInteger(entry?.max_pages) && entry.max_pages > 0
    ? entry.max_pages
    : defaultLimit;
  const contextLimit = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0
    ? ctx.maxPages
    : hardLimit;
  return Math.min(configured, contextLimit, hardLimit);
}

export function parseIcimsSearchPage(html, origin, companyName) {
  const jobs = [];
  const cards = String(html ?? '').split('iCIMS_JobCardItem').slice(1);
  const seen = new Set();
  for (const card of cards) {
    const hrefMatch = card.match(/href=["']([^"']*\/jobs\/(\d+)\/[^"'/]+\/job[^"']*)["']/i);
    if (!hrefMatch) continue;
    let parsed;
    try {
      parsed = new URL(decodeHtmlEntities(hrefMatch[1]), origin);
    } catch {
      continue;
    }
    if (parsed.origin !== origin) continue;
    const id = hrefMatch[2];
    if (seen.has(id)) continue;
    const titleMatch = card.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i);
    const title = htmlToPlainText(titleMatch?.[1] ?? '');
    if (!title) continue;
    const locationMatch = card.match(
      /<span\b[^>]*class=["'][^"']*(?<![\w-])field-label(?![\w-])[^"']*["'][^>]*>\s*Location\s*<\/span>\s*<span\b[^>]*>([\s\S]*?)<\/span>/i,
    );
    seen.add(id);
    jobs.push({
      id,
      title,
      url: `${parsed.origin}${parsed.pathname}`,
      company: companyName,
      location: htmlToPlainText(locationMatch?.[1] ?? ''),
      acquisitionMode: 'classic-html',
    });
  }
  return jobs;
}

function isAwsWafCaptcha(error) {
  if (Number(error?.status) !== 405) return false;
  const body = typeof error?.body === 'string' ? error.body : '';
  return /<title>\s*Human Verification\s*<\/title>/i.test(body)
    && /awsWafCookieDomainList|gokuProps/i.test(body);
}

function wafCaptchaError(error, entry) {
  const wrapped = new Error(
    `iCIMS classic portal requires AWS WAF human verification for ${entry.name}`,
    { cause: error },
  );
  wrapped.code = 'ICIMS_WAF_CAPTCHA';
  return wrapped;
}

function text(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).trim();
}

function numericJobId(value) {
  const valueText = text(value);
  return /^[1-9]\d*$/.test(valueText) ? valueText : null;
}

export function parseJibeApplyIdentity(rawUrl, expectedId = null) {
  const parsed = cleanHttpsUrl(rawUrl);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase();
  if (!ICIMS_HOST_RE.test(host) || host === 'www.icims.com') return null;
  const match = parsed.pathname.match(/^\/jobs\/(\d+)(?:\/|$)/i);
  if (!match) return null;
  const externalId = match[1];
  if (expectedId != null && externalId !== String(expectedId)) return null;
  return {
    provider: 'icims',
    providerTenant: host,
    externalId,
    applyUrl: parsed.href,
  };
}

function locationText(data) {
  const direct = text(data?.full_location) || text(data?.short_location);
  if (direct) return direct;
  const parts = [data?.city, data?.state, data?.country].map(text).filter(Boolean);
  return [...new Set(parts)].join(', ');
}

function publicJibeJobUrl(data, endpoint, id) {
  const clientCode = text(data?.client_code);
  const path = clientCode
    ? `/${encodeURIComponent(clientCode)}/jobs/${encodeURIComponent(id)}`
    : `/jobs/${encodeURIComponent(id)}`;
  return new URL(path, endpoint.origin).href;
}

function descriptionText(data) {
  const sections = [
    ['Description', data?.description],
    ['Responsibilities', data?.responsibilities],
    ['Qualifications', data?.qualifications],
  ];
  const output = [];
  const seen = new Set();
  for (const [label, raw] of sections) {
    const plain = htmlToPlainText(text(raw));
    if (!plain || seen.has(plain)) continue;
    seen.add(plain);
    output.push(`${label}\n${plain}`);
  }
  return output.join('\n\n');
}

export function parseJibeJobsPage(payload, entry, endpoint) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`icims:jibe: ${entry.name} returned a non-object response`);
  }
  if (Object.hasOwn(payload, 'error') && !Array.isArray(payload.jobs)) {
    const error = new Error(`icims:jibe: ${entry.name} rejected the job query`);
    error.code = 'ICIMS_JIBE_QUERY_REJECTED';
    throw error;
  }
  if (!Array.isArray(payload.jobs)) {
    throw new Error(`icims:jibe: ${entry.name} omitted the jobs list`);
  }

  const jobs = [];
  const seen = new Set();
  for (let index = 0; index < payload.jobs.length; index += 1) {
    const wrapper = payload.jobs[index];
    const data = wrapper?.data ?? wrapper;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`icims:jibe: job row ${index} is not an object`);
    }
    if (data.internal === true) continue;
    if (typeof data.ats_code === 'string' && data.ats_code.trim().toLowerCase() !== 'icims') {
      throw new Error(`icims:jibe: job row ${index} has unexpected ats_code`);
    }

    const id = numericJobId(data.req_id ?? data.slug);
    if (!id) throw new Error(`icims:jibe: job row ${index} has no numeric requisition id`);
    const identity = parseJibeApplyIdentity(data.apply_url, id);
    if (!identity) {
      throw new Error(`icims:jibe: job row ${index} has no matching iCIMS apply identity`);
    }
    const title = text(data.title);
    if (!title) throw new Error(`icims:jibe: job row ${index} omitted title`);

    const dedupeKey = `${identity.providerTenant}\0${id}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    jobs.push({
      id,
      title,
      url: publicJibeJobUrl(data, endpoint, id),
      applyUrl: identity.applyUrl,
      company: text(data.hiring_organization) || text(entry.name),
      location: locationText(data),
      description: descriptionText(data),
      postedAt: text(data.posted_date) || undefined,
      explicitIdentity: {
        provider: identity.provider,
        providerTenant: identity.providerTenant,
        externalId: identity.externalId,
      },
      acquisitionMode: 'jibe-api',
    });
  }
  return jobs;
}

async function fetchClassic(entry, ctx) {
  const origin = resolveIcimsOrigin(entry);
  if (!origin) throw new Error(`icims: cannot resolve classic portal for ${entry.name}`);
  ctx.reportProviderTelemetry?.({ acquisitionMode: 'classic-html' });

  const bootstrap = introUrl(origin);
  let bootstrapHtml;
  try {
    bootstrapHtml = await ctx.fetchText(bootstrap, {
      redirect: 'error',
      headers: CLASSIC_HEADERS,
    });
  } catch (error) {
    if (isAwsWafCaptcha(error)) throw wafCaptchaError(error, entry);
    throw error;
  }
  let pageUrl = resolveIcimsSearchUrl(bootstrapHtml, origin);
  if (!pageUrl) {
    throw new Error(`icims: portal intro has no same-origin job search link for ${entry.name}`);
  }

  const all = [];
  const seenJobs = new Set();
  const seenPages = new Set();
  const limit = maxPages(entry, ctx, {
    defaultLimit: CLASSIC_DEFAULT_MAX_PAGES,
    hardLimit: CLASSIC_HARD_MAX_PAGES,
  });
  let referer = bootstrap;

  for (let page = 0; page < limit; page += 1) {
    if (seenPages.has(pageUrl)) break;
    seenPages.add(pageUrl);
    if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);

    let html;
    try {
      html = await ctx.fetchText(pageUrl, {
        redirect: 'error',
        headers: { ...CLASSIC_HEADERS, referer },
      });
    } catch (error) {
      if (isAwsWafCaptcha(error)) throw wafCaptchaError(error, entry);
      throw error;
    }
    const pageJobs = parseIcimsSearchPage(html, origin, entry.name);
    if (pageJobs.length === 0) break;
    for (const job of pageJobs) {
      if (seenJobs.has(job.id)) continue;
      seenJobs.add(job.id);
      all.push(job);
    }

    const nextPageUrl = resolveIcimsNextPageUrl(html, origin, page);
    if (!nextPageUrl) break;
    referer = pageUrl;
    pageUrl = nextPageUrl;
  }
  return all;
}

async function fetchJibe(entry, ctx) {
  const endpoint = resolveJibeEndpoint(entry);
  if (!endpoint) throw new Error(`icims:jibe: cannot resolve API endpoint for ${entry.name}`);
  ctx.reportProviderTelemetry?.({ acquisitionMode: 'jibe-api' });

  const all = [];
  const seen = new Set();
  const limit = maxPages(entry, ctx, {
    defaultLimit: JIBE_DEFAULT_MAX_PAGES,
    hardLimit: JIBE_HARD_MAX_PAGES,
  });
  let explicitTotal = null;
  let effectivePageSize = null;

  for (let page = 1; page <= limit; page += 1) {
    if (page > 1) await sleep(INTER_PAGE_DELAY_MS, ctx);
    const url = new URL(endpoint.apiUrl);
    url.searchParams.set('page', String(page));
    url.searchParams.set('limit', String(JIBE_PAGE_SIZE));
    url.searchParams.set('sortBy', 'relevance');
    url.searchParams.set('internal', 'false');

    const payload = await ctx.fetchJson(url.href, {
      redirect: 'error',
      headers: JIBE_HEADERS,
    });
    const pageJobs = parseJibeJobsPage(payload, entry, endpoint);
    const rawPageSize = Array.isArray(payload?.jobs) ? payload.jobs.length : 0;
    if (effectivePageSize == null && rawPageSize > 0) effectivePageSize = rawPageSize;
    const total = Number(payload?.totalCount);
    if (Number.isInteger(total) && total >= 0) explicitTotal = total;

    for (const job of pageJobs) {
      const key = `${job.explicitIdentity.providerTenant}\0${job.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(job);
    }

    if (rawPageSize === 0) break;
    if (explicitTotal != null && effectivePageSize != null
      && page * effectivePageSize >= explicitTotal) break;
    if (rawPageSize < JIBE_PAGE_SIZE && explicitTotal == null) break;
  }

  ctx.reportProviderTelemetry?.({
    acquisitionMode: 'jibe-api',
    explicitTotal,
  });
  return all;
}

export default {
  id: 'icims',
  source: sourceMeta,
  capabilities: Object.freeze({
    listDescription: false,
    detail: true,
    importReady: true,
    providerDateFilter: false,
    explicitIdentityPreflight: true,
  }),
  detect(entry) {
    const endpoint = resolveJibeEndpoint(entry);
    if (endpoint && (icimsVariant(entry) === 'jibe' || JIBE_HOST_RE.test(new URL(endpoint.origin).hostname))) {
      return { url: endpoint.apiUrl };
    }
    const origin = resolveIcimsOrigin(entry);
    return origin ? { url: introUrl(origin) } : null;
  },
  tenant(entry) {
    if (icimsVariant(entry) === 'jibe') {
      return resolveJibeEndpoint(entry) ? new URL(resolveJibeEndpoint(entry).origin).hostname : null;
    }
    return resolveIcimsOrigin(entry) ? new URL(resolveIcimsOrigin(entry)).hostname : null;
  },
  sourceOrigin(entry) {
    if (icimsVariant(entry) === 'jibe') return resolveJibeEndpoint(entry)?.origin ?? null;
    return resolveIcimsOrigin(entry);
  },
  async fetch(entry, ctx) {
    return icimsVariant(entry) === 'jibe'
      ? fetchJibe(entry, ctx)
      : fetchClassic(entry, ctx);
  },
};
