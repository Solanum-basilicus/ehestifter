// Portions adapted from santifer/career-ops providers/successfactors.mjs.
// Upstream ref: b62327145a789c966978f2e0a9ec03c1ca431af6 (MIT).

import { decodeHtmlEntities, htmlToPlainText } from '../text/html.mjs';
import { providerSourceMeta } from './_source-meta.mjs';
import { successFactorsVariant } from './_variant.mjs';
import { assertPublicHttpsUrl } from './_url-safety.mjs';

const RMK_MAX_PAGES = 40;
const MAX_JOBS = 1000;
const CSB_PAGE_SIZE = 10;
const CSB_MAX_PAGES_PER_LOCALE = 100;
const CSB_MAX_LOCALES = 16;
const CSB_MAX_CATEGORIES = 16;
const CSB_MAX_TOTAL_REQUESTS = 200;
const CSB_DEFAULT_LOCALES = Object.freeze(['de_DE', 'en_US']);
const CSB_LOCALE_PRIORITY = Object.freeze(['de_DE', 'en_US', 'en_GB', 'en_EN']);

export const sourceMeta = providerSourceMeta({
  file: 'providers/successfactors.mjs',
  ref: 'b62327145a789c966978f2e0a9ec03c1ca431af6',
  changes: [
    'public-HTTPS validation for branded RMK and CSB origins',
    'provider-owned tenant derivation preserving brand path prefixes',
    'bounded RMK and multi-locale CSB pagination with structured fixtures',
    'per-target CSB cookie/CSRF bootstrap with one safe session refresh',
    'CSB ajaxSetup token extraction verified against jobs.hr.cloud.sap markup',
    'public tile/category fallback when anonymous CSB API bootstrap is unavailable',
  ],
});

function clean(value) {
  return htmlToPlainText(decodeHtmlEntities(String(value ?? '')));
}

function reportTelemetry(ctx, value) {
  if (typeof ctx?.reportProviderTelemetry === 'function') {
    ctx.reportProviderTelemetry(value);
  }
}

function listingFailureOutcome(error) {
  if (error?.code === 'CSB_LISTING_SCHEMA_MISMATCH') return 'listing_schema_error';
  if ([
    'CSB_SESSION_REJECTED',
    'CSB_BOOTSTRAP_TOKEN_MISSING',
  ].includes(error?.code)) return 'listing_auth_error';
  return 'listing_error';
}

function endpointBase(raw, label = 'SuccessFactors URL') {
  const parsed = assertPublicHttpsUrl(raw, label);
  parsed.search = '';
  parsed.hash = '';
  const pathname = parsed.pathname
    .replace(/\/(?:search|tile-search-results|services\/recruiting\/v1\/jobs)\/?$/i, '')
    .replace(/\/+$/, '');
  return {
    parsed,
    path: pathname,
    base: `${parsed.origin}${pathname}`,
  };
}

export function resolveSuccessFactorsConfig(entry) {
  const raw = entry?.api || entry?.careers_url || '';
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let resolved;
  try {
    resolved = endpointBase(raw, 'SuccessFactors source URL');
  } catch {
    return null;
  }
  return {
    origin: resolved.parsed.origin,
    base: resolved.base,
    path: resolved.path,
    tileApi: `${resolved.base}/tile-search-results/`,
    jobBase: resolved.parsed.origin,
    jobsApi: `${resolved.base}/services/recruiting/v1/jobs`,
    searchPage: `${resolved.base}/search/`,
  };
}

function autoDetectable(entry) {
  const raw = entry?.api || entry?.careers_url || '';
  if (typeof raw !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return host === 'successfactors.eu'
    || host.endsWith('.successfactors.eu')
    || host === 'successfactors.com'
    || host.endsWith('.successfactors.com')
    || host === 'jobs2web.com'
    || host.endsWith('.jobs2web.com');
}

export function successFactorsTenant(entry) {
  if (typeof entry?.provider_tenant === 'string' && entry.provider_tenant.trim()) {
    return entry.provider_tenant.trim();
  }
  const cfg = resolveSuccessFactorsConfig(entry);
  if (!cfg) return null;
  return `${new URL(cfg.origin).hostname.toLowerCase()}${cfg.path}`;
}

export function cityFromSlug(dataUrl, title) {
  const decodedEntities = decodeHtmlEntities(String(dataUrl ?? ''));
  let path;
  try {
    path = decodeURIComponent(decodedEntities);
  } catch {
    path = decodedEntities;
  }
  const slugMatch = path.match(/\/job\/([^/]+)\//i);
  if (!slugMatch) return '';
  const words = String(title ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!words?.length) return '';
  const escape = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let anchor;
  try {
    anchor = new RegExp(
      words.slice(0, 2).map(escape).join('[^\\p{L}\\p{N}]+'),
      'u',
    );
  } catch {
    return '';
  }
  const slug = slugMatch[1].toLowerCase();
  const hit = slug.match(anchor);
  if (!hit || hit.index == null || hit.index <= 0) return '';
  return slug.slice(0, hit.index)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

export function parseSuccessFactorsTiles(html, jobBase) {
  if (typeof html !== 'string') return [];
  const out = [];
  const liRe = /<li\b([^>]*)>([\s\S]*?)<\/li>/gi;
  let match;
  while ((match = liRe.exec(html)) !== null) {
    const attrs = match[1];
    const block = match[2];
    const className = attrs.match(/\bclass="([^"]+)"/i)?.[1] ?? '';
    if (!/(?:^|\s)job-tile(?:\s|$)/.test(className)) continue;
    const id = className.match(/(?:^|\s)job-id-([^\s"]+)/)?.[1] ?? '';
    const dataUrl = attrs.match(/\bdata-url="([^"]+)"/i)?.[1]
      ?? block.match(/\bdata-url="([^"]+)"/i)?.[1]
      ?? block.match(/<a\b[^>]*href="([^"]+)"/i)?.[1]
      ?? '';
    const titleHtml = block.match(/<a\b[^>]*class="[^"]*\bjobTitle-link\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i)?.[1]
      ?? block.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1]
      ?? '';
    const title = clean(titleHtml);
    if (!id || !title || !dataUrl) continue;
    const decodedPath = decodeHtmlEntities(dataUrl);
    const cityHtml = block.match(/id="[^"]*-section-city-value"[^>]*>([\s\S]*?)<\/div>/i)?.[1];
    const location = cityHtml ? clean(cityHtml) : cityFromSlug(decodedPath, title);
    let url;
    try {
      url = new URL(decodedPath, jobBase).href;
    } catch {
      continue;
    }
    out.push({ id, title, url, location });
  }
  return out;
}

export function extractSuccessFactorsLocales(html) {
  const found = new Set();
  const re = /locale=([a-z]{2}_[A-Z]{2})\b/g;
  let match;
  while ((match = re.exec(String(html ?? ''))) !== null) found.add(match[1]);
  const priority = (locale) => {
    const index = CSB_LOCALE_PRIORITY.indexOf(locale);
    return index < 0 ? CSB_LOCALE_PRIORITY.length : index;
  };
  return [...found]
    .sort((left, right) => priority(left) - priority(right) || left.localeCompare(right))
    .slice(0, CSB_MAX_LOCALES);
}



function normalizeCsbCsrfToken(raw) {
  const token = decodeHtmlEntities(String(raw ?? '')).trim();
  if (!token || token.length > 4096) return null;
  if (/^(?:fetch|null|undefined)$/i.test(token)) return null;
  if (/[\u0000-\u001f\u007f]/u.test(token)) return null;
  return token;
}

export function extractSuccessFactorsCsbBootstrap(html) {
  const source = String(html ?? '');
  const tokenPatterns = [
    /<meta\b(?=[^>]*\bname=["']csrf-token["'])(?=[^>]*\bcontent=["']([^"']+)["'])[^>]*>/i,
    /<meta\b(?=[^>]*\bcontent=["']([^"']+)["'])(?=[^>]*\bname=["']csrf-token["'])[^>]*>/i,
    /\bdata-csrf-token=["']([^"']+)["']/i,
    /["']X-CSRF-Token["']\s*:\s*["']([^"'\r\n]{1,4096})["']/i,
    /\bx-csrf-token\s*[:=]\s*["']?([A-Za-z0-9._~+\/=-]+)["']?/i,
  ];
  let csrfToken = null;
  for (const pattern of tokenPatterns) {
    const match = source.match(pattern);
    csrfToken = normalizeCsbCsrfToken(match?.[1]);
    if (csrfToken) break;
  }

  const categoryIds = new Set();
  for (const match of source.matchAll(/\/go\/[^/"'?#]+\/(\d+)(?:[/?#"']|$)/gi)) {
    categoryIds.add(Number(match[1]));
    if (categoryIds.size >= CSB_MAX_CATEGORIES) break;
  }
  if (categoryIds.size === 0) {
    for (const match of source.matchAll(/["']categoryId["']\s*:\s*(\d+)/gi)) {
      categoryIds.add(Number(match[1]));
      if (categoryIds.size >= CSB_MAX_CATEGORIES) break;
    }
  }

  return {
    csrfToken,
    categoryIds: [...categoryIds].filter(Number.isInteger).sort((a, b) => a - b),
    locales: extractSuccessFactorsLocales(source),
  };
}

export function parseSuccessFactorsDate(raw) {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  const slash = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  const dot = value.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  let month;
  let day;
  let year;
  if (slash) {
    month = Number(slash[1]);
    day = Number(slash[2]);
    year = Number(slash[3]);
  } else if (dot) {
    day = Number(dot[1]);
    month = Number(dot[2]);
    year = Number(dot[3]);
  } else {
    return undefined;
  }
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const result = Date.UTC(year, month - 1, day);
  const check = new Date(result);
  if (
    check.getUTCFullYear() !== year
    || check.getUTCMonth() !== month - 1
    || check.getUTCDate() !== day
  ) return undefined;
  return result;
}

export function cleanSuccessFactorsLocation(raw) {
  const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const seen = new Set();
  const cleaned = [];
  for (const value of values) {
    const location = clean(value);
    const key = location.toLowerCase();
    if (location && !seen.has(key)) {
      seen.add(key);
      cleaned.push(location);
    }
  }
  return cleaned.join(' / ');
}

export function parseSuccessFactorsCsbJobs(json, cfg, locale) {
  const rows = Array.isArray(json?.jobSearchResult) ? json.jobSearchResult : [];
  const jobs = [];
  for (const item of rows) {
    const response = item?.response;
    const id = response?.id == null ? '' : String(response.id);
    const title = clean(response?.unifiedStandardTitle || response?.jobTitle || '');
    if (!id || !title) continue;
    const slug = decodeHtmlEntities(
      String(response.unifiedUrlTitle || response.urlTitle || 'job'),
    ).replace(/[\/\\?#&]+/g, '-').replace(/\s+/g, '-').replace(/-{2,}/g, '-');
    const job = {
      id,
      title,
      url: `${cfg.base}/job/${slug}/${id}-${locale}`,
      location: cleanSuccessFactorsLocation(response.jobLocationShort),
    };
    const postedAt = parseSuccessFactorsDate(response.unifiedStandardStart);
    if (postedAt !== undefined) job.postedAt = postedAt;
    jobs.push(job);
  }
  return jobs;
}


function sameSuccessFactorsOrigin(value, cfg) {
  try {
    const parsed = new URL(value, cfg.base);
    return parsed.protocol === 'https:' && parsed.origin === cfg.origin;
  } catch {
    return false;
  }
}

export function extractSuccessFactorsPublicListingUrls(html, cfg) {
  const urls = [];
  const seen = new Set();
  const source = String(html ?? '');
  for (const match of source.matchAll(/<a\b[^>]*\bhref=["']([^"']*\/go\/[^"']+)["'][^>]*>/gi)) {
    try {
      const url = new URL(decodeHtmlEntities(match[1]), cfg.base);
      url.hash = '';
      if (!sameSuccessFactorsOrigin(url, cfg)) continue;
      const key = url.href;
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push(key);
      if (urls.length >= CSB_MAX_CATEGORIES) break;
    } catch {
      /* Ignore malformed category links. */
    }
  }
  return urls;
}

export function parseSuccessFactorsPublicJobsPage(html, pageUrl, cfg) {
  const base = pageUrl instanceof URL ? pageUrl : new URL(pageUrl);
  const jobs = [];
  const seen = new Set();
  const source = String(html ?? '');
  const anchorRe = /<a\b([^>]*\bhref=["']([^"']*\/job\/([^"']+))["'][^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(source)) !== null) {
    let url;
    try {
      url = new URL(decodeHtmlEntities(match[2]), base);
    } catch {
      continue;
    }
    if (!sameSuccessFactorsOrigin(url, cfg)) continue;
    const id = url.pathname.match(/\/(\d+)(?:-[a-z]{2}_[A-Z]{2})?\/?$/)?.[1]
      ?? url.pathname.match(/\/(\d+)\/?$/)?.[1]
      ?? '';
    const title = clean(match[4]);
    if (!id || !title || seen.has(id)) continue;
    if (/^(?:apply(?: now)?|view job|job details|learn more)$/i.test(title)) continue;
    seen.add(id);
    const contextStart = Math.max(0, match.index - 1200);
    const contextEnd = Math.min(source.length, anchorRe.lastIndex + 1200);
    const context = source.slice(contextStart, contextEnd);
    const location = clean(
      context.match(/class=["'][^"']*(?:jobLocation|job-location|location)[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1]
      ?? '',
    );
    jobs.push({ id, title, url: url.href, location });
    if (jobs.length >= MAX_JOBS) break;
  }
  return jobs;
}

function integerCap(value, fallback, maximum) {
  return Number.isInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

async function fetchRmk(entry, cfg, ctx) {
  const jobs = [];
  const seen = new Set();
  const maxPages = integerCap(entry.max_pages, RMK_MAX_PAGES, RMK_MAX_PAGES);
  let startrow = 0;
  for (let page = 0; page < maxPages && jobs.length < MAX_JOBS; page += 1) {
    const endpoint = new URL(cfg.tileApi);
    endpoint.searchParams.set('startrow', String(startrow));
    const html = await ctx.fetchText(endpoint, {
      redirect: 'error',
      headers: { accept: 'text/html' },
    });
    const tiles = parseSuccessFactorsTiles(html, cfg.jobBase);
    if (tiles.length === 0) break;
    let fresh = 0;
    for (const tile of tiles) {
      if (seen.has(tile.id)) continue;
      seen.add(tile.id);
      fresh += 1;
      jobs.push({
        id: tile.id,
        title: tile.title,
        url: tile.url,
        company: entry.name,
        location: tile.location,
      });
      if (jobs.length >= MAX_JOBS) break;
    }
    if (fresh === 0) break;
    startrow += tiles.length;
  }
  return jobs;
}

function explicitLocales(entry) {
  const raw = entry.sf_locales ?? entry.sfLocales;
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];
  const valid = values
    .map((value) => String(value).trim())
    .filter((value) => /^[a-z]{2}_[A-Z]{2}$/.test(value));
  return [...new Set(valid)].slice(0, CSB_MAX_LOCALES);
}

async function bootstrapCsb(cfg, ctx) {
  const bootstrapUrl = `${cfg.base}/`;
  const html = await ctx.fetchText(bootstrapUrl, {
    redirect: 'follow',
    headers: {
      accept: 'text/html,application/xhtml+xml',
      referer: cfg.searchPage,
      'x-csrf-token': 'Fetch',
    },
  });
  return {
    ...extractSuccessFactorsCsbBootstrap(html),
    html,
    bootstrapUrl,
  };
}

function csbPayload({ locale, page, categoryId }) {
  return {
    keywords: '',
    locale,
    location: '',
    pageNumber: page,
    sortBy: '',
    facetFilters: {},
    brand: '',
    skills: [],
    categoryId,
    alertId: '',
    rcmCandidateId: '',
  };
}

async function fetchCsbJson({ cfg, ctx, bootstrap, locale, page, categoryId }) {
  const request = () => ctx.fetchJson(cfg.jobsApi, {
    method: 'POST',
    redirect: 'error',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-csrf-token': bootstrap.csrfToken,
      origin: cfg.origin,
      referer: cfg.searchPage,
    },
    body: JSON.stringify(csbPayload({ locale, page, categoryId })),
  });

  try {
    return await request();
  } catch (error) {
    if (![401, 403].includes(error?.status)) throw error;
    const refreshed = await bootstrapCsb(cfg, ctx);
    if (!refreshed.csrfToken) {
      const missing = new Error('successfactors: csb_bootstrap_token_missing_after_refresh');
      missing.code = 'CSB_BOOTSTRAP_TOKEN_MISSING';
      throw missing;
    }
    bootstrap.csrfToken = refreshed.csrfToken;
    bootstrap.locales = refreshed.locales;
    bootstrap.categoryIds = refreshed.categoryIds;
    try {
      return await request();
    } catch (retryError) {
      if ([401, 403].includes(retryError?.status)) {
        const safe = new Error('successfactors: csb_session_rejected_after_refresh');
        safe.status = retryError.status;
        safe.code = 'CSB_SESSION_REJECTED';
        throw safe;
      }
      throw retryError;
    }
  }
}

async function fetchCsbPublicFallback(entry, cfg, ctx, bootstrap, {
  allowRmkFallback,
  fallbackCause = null,
} = {}) {
  if (allowRmkFallback) {
    try {
      const tiles = await fetchRmk(entry, cfg, ctx);
      if (tiles.length > 0) {
        return tiles.map((job) => ({ ...job, acquisitionMode: 'csb-public-tiles' }));
      }
    } catch {
      /* Some CSB hosts do not expose the public tile endpoint. */
    }
  }

  const explicit = entry.sf_listing_url ?? entry.sfListingUrl ?? null;
  const listingUrls = [];
  if (explicit) {
    const parsed = assertPublicHttpsUrl(explicit, 'SuccessFactors public listing URL');
    if (parsed.origin !== cfg.origin) {
      throw new Error('successfactors: sf_listing_url must match source origin');
    }
    listingUrls.push(parsed.href);
  }
  for (const url of extractSuccessFactorsPublicListingUrls(bootstrap?.html, cfg)) {
    if (!listingUrls.includes(url)) listingUrls.push(url);
  }
  if (listingUrls.length === 0) listingUrls.push(cfg.searchPage);

  const jobs = [];
  const seen = new Set();
  const maxPages = integerCap(entry.max_pages, 1, RMK_MAX_PAGES);
  for (const listingUrl of listingUrls.slice(0, CSB_MAX_CATEGORIES)) {
    for (let page = 0; page < maxPages && jobs.length < MAX_JOBS; page += 1) {
      const endpoint = new URL(listingUrl);
      if (page > 0) endpoint.searchParams.set('startrow', String(page * 25));
      const html = await ctx.fetchText(endpoint, {
        redirect: 'follow',
        headers: { accept: 'text/html,application/xhtml+xml' },
      });
      const rows = parseSuccessFactorsPublicJobsPage(html, endpoint, cfg);
      let fresh = 0;
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        fresh += 1;
        jobs.push({
          ...row,
          company: entry.name,
          acquisitionMode: 'csb-public-page',
        });
        if (jobs.length >= MAX_JOBS) break;
      }
      if (rows.length === 0 || fresh === 0) break;
    }
  }
  if (jobs.length === 0) {
    if (fallbackCause?.code === 'CSB_SESSION_REJECTED') {
      const error = new Error(
        'successfactors: csb_session_rejected_and_public_listing_empty',
      );
      error.code = 'CSB_SESSION_REJECTED';
      error.status = fallbackCause.status;
      throw error;
    }
    if (fallbackCause?.code === 'CSB_BOOTSTRAP_TOKEN_MISSING') {
      const error = new Error(
        'successfactors: csb_bootstrap_token_missing_and_public_listing_empty',
      );
      error.code = 'CSB_BOOTSTRAP_TOKEN_MISSING';
      throw error;
    }
    const error = new Error('successfactors: csb_public_listing_empty');
    error.code = 'CSB_PUBLIC_LISTING_EMPTY';
    throw error;
  }
  reportTelemetry(ctx, {
    acquisitionMode: jobs[0]?.acquisitionMode ?? 'csb-public-page',
    listingOutcome: 'listing_success_nonempty',
    explicitTotal: null,
  });
  return jobs;
}

async function fetchCsb(entry, cfg, ctx, { allowRmkFallback = true } = {}) {
  let bootstrap;
  try {
    bootstrap = await bootstrapCsb(cfg, ctx);
  } catch (error) {
    return fetchCsbPublicFallback(entry, cfg, ctx, null, {
      allowRmkFallback,
      fallbackCause: error,
    });
  }
  if (!bootstrap.csrfToken) {
    const fallbackCause = new Error('successfactors: csb_bootstrap_token_missing');
    fallbackCause.code = 'CSB_BOOTSTRAP_TOKEN_MISSING';
    return fetchCsbPublicFallback(entry, cfg, ctx, bootstrap, {
      allowRmkFallback,
      fallbackCause,
    });
  }
  let locales = explicitLocales(entry);
  if (locales.length === 0) locales = bootstrap.locales;
  if (locales.length === 0) locales = [...CSB_DEFAULT_LOCALES];
  const categoryIds = bootstrap.categoryIds.length > 0
    ? bootstrap.categoryIds
    : [0];

  const maxPages = integerCap(
    entry.max_pages,
    CSB_MAX_PAGES_PER_LOCALE,
    CSB_MAX_PAGES_PER_LOCALE,
  );
  const jobs = [];
  const seen = new Set();
  let successfulRequests = 0;
  let lastRequestError = null;
  let requestCount = 0;
  let sawExplicitZero = false;
  let lastExplicitTotal = null;

  for (const categoryId of categoryIds) {
    if (jobs.length >= MAX_JOBS || requestCount >= CSB_MAX_TOTAL_REQUESTS) break;
    for (const locale of locales) {
      if (jobs.length >= MAX_JOBS || requestCount >= CSB_MAX_TOTAL_REQUESTS) break;
      let total = null;
      for (let page = 0; (
        page < maxPages
        && jobs.length < MAX_JOBS
        && requestCount < CSB_MAX_TOTAL_REQUESTS
      ); page += 1) {
        let json;
        try {
          requestCount += 1;
          json = await fetchCsbJson({
            cfg,
            ctx,
            bootstrap,
            locale,
            page,
            categoryId,
          });
        } catch (error) {
          if ([
            'CSB_SESSION_REJECTED',
            'CSB_BOOTSTRAP_TOKEN_MISSING',
          ].includes(error?.code)) {
            return fetchCsbPublicFallback(entry, cfg, ctx, bootstrap, {
              allowRmkFallback,
              fallbackCause: error,
            });
          }
          lastRequestError = error;
          break;
        }
        successfulRequests += 1;
        const rows = json?.jobSearchResult;
        const reportedTotal = Number.isInteger(json?.totalJobs) && json.totalJobs >= 0
          ? json.totalJobs
          : null;
        if (!Array.isArray(rows)) {
          const error = new Error('successfactors: csb_listing_schema_mismatch');
          error.code = 'CSB_LISTING_SCHEMA_MISMATCH';
          throw error;
        }
        if (total == null && reportedTotal != null) total = reportedTotal;
        if (reportedTotal != null) lastExplicitTotal = reportedTotal;
        const rawCount = rows.length;
        if (rawCount === 0) {
          if (reportedTotal === 0) {
            sawExplicitZero = true;
            break;
          }
          if (reportedTotal == null || reportedTotal > 0) {
            const error = new Error('successfactors: csb_listing_schema_mismatch');
            error.code = 'CSB_LISTING_SCHEMA_MISMATCH';
            throw error;
          }
        }
        for (const row of parseSuccessFactorsCsbJobs(json, cfg, locale)) {
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          jobs.push({
            ...row,
            company: entry.name,
            acquisitionMode: 'csb-api',
          });
          if (jobs.length >= MAX_JOBS || requestCount >= CSB_MAX_TOTAL_REQUESTS) break;
        }
        if (total != null && (page + 1) * CSB_PAGE_SIZE >= total) break;
        if (rawCount < CSB_PAGE_SIZE) break;
      }
    }
  }
  if ((successfulRequests === 0 || jobs.length === 0) && lastRequestError) {
    if ([401, 403].includes(lastRequestError?.status)
      || lastRequestError?.code === 'CSB_SESSION_REJECTED') {
      return fetchCsbPublicFallback(entry, cfg, ctx, bootstrap, {
        allowRmkFallback,
        fallbackCause: lastRequestError,
      });
    }
    throw lastRequestError;
  }
  if (jobs.length === 0 && sawExplicitZero && lastRequestError == null) {
    reportTelemetry(ctx, {
      acquisitionMode: 'csb-api',
      listingOutcome: 'listing_success_explicit_empty',
      explicitTotal: lastExplicitTotal ?? 0,
    });
    return [];
  }
  if (jobs.length === 0) {
    return fetchCsbPublicFallback(entry, cfg, ctx, bootstrap, { allowRmkFallback });
  }
  reportTelemetry(ctx, {
    acquisitionMode: 'csb-api',
    listingOutcome: 'listing_success_nonempty',
    explicitTotal: lastExplicitTotal,
  });
  return jobs;
}

export default {
  id: 'successfactors',
  source: sourceMeta,
  capabilities: Object.freeze({
    listDescription: false,
    detail: true,
    importReady: true,
    providerDateFilter: false,
  }),
  detect(entry) {
    if (!autoDetectable(entry)) return null;
    const cfg = resolveSuccessFactorsConfig(entry);
    return cfg ? { url: cfg.tileApi } : null;
  },
  tenant(entry) {
    return successFactorsTenant(entry);
  },
  sourceOrigin(entry) {
    return resolveSuccessFactorsConfig(entry)?.origin ?? null;
  },
  async fetch(entry, ctx) {
    const cfg = resolveSuccessFactorsConfig(entry);
    if (!cfg) {
      throw new Error(`successfactors: cannot resolve source URL for ${entry.name}`);
    }
    const variant = successFactorsVariant(entry);
    try {
      if (variant === 'csb') {
        return await fetchCsb(entry, cfg, ctx, { allowRmkFallback: true });
      }
      const rmk = await fetchRmk(entry, cfg, ctx);
      reportTelemetry(ctx, {
        acquisitionMode: 'rmk-html',
        listingOutcome: rmk.length > 0
          ? 'listing_success_nonempty'
          : 'listing_success_empty_unverified',
        explicitTotal: null,
      });
      return rmk;
    } catch (error) {
      reportTelemetry(ctx, {
        acquisitionMode: variant === 'csb' ? 'csb-api' : 'rmk-html',
        listingOutcome: listingFailureOutcome(error),
        explicitTotal: null,
      });
      throw error;
    }
  },
};
