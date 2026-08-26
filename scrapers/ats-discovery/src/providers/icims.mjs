// Portions adapted from santifer/career-ops providers/icims.mjs.
// Upstream ref: b9cd65e8ddba9448c9590c25f45288cf61c1c1c7 (MIT).

import { BROWSER_LIKE_USER_AGENT } from './_http.mjs';
import { providerSourceMeta } from './_source-meta.mjs';
import { decodeHtmlEntities, htmlToPlainText } from '../text/html.mjs';

const ICIMS_HOST_RE = /^[a-z0-9][a-z0-9.-]*\.icims\.com$/;
const DEFAULT_MAX_PAGES = 30;
const HARD_MAX_PAGES = 30;
const INTER_PAGE_DELAY_MS = 150;
const HEADERS = Object.freeze({
  accept: 'text/html,application/xhtml+xml',
  'user-agent': BROWSER_LIKE_USER_AGENT,
  'accept-language': 'en-US,en;q=0.9',
});

export const sourceMeta = providerSourceMeta({
  file: 'providers/icims.mjs',
  ref: 'b9cd65e8ddba9448c9590c25f45288cf61c1c1c7',
  changes: [
    'portal bootstrap that follows the tenant-generated search entry URL',
    'bounded pagination that follows same-origin iCIMS page links',
    'full portal host as provider tenant to prevent cross-tenant id collisions',
    'provider-native numeric job ids for shared detail and identity checks',
  ],
});

function sleep(ms, ctx) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveIcimsOrigin(entry) {
  for (const raw of [entry.api, entry.careers_url]) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    let parsed;
    try {
      parsed = new URL(raw.trim());
    } catch {
      continue;
    }
    const host = parsed.hostname.toLowerCase();
    if (
      parsed.protocol !== 'https:'
      || !ICIMS_HOST_RE.test(host)
      || host === 'www.icims.com'
    ) continue;
    return `https://${host}`;
  }
  return null;
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

function maxPages(entry, ctx) {
  const configured = Number.isInteger(entry?.max_pages) && entry.max_pages > 0
    ? entry.max_pages
    : DEFAULT_MAX_PAGES;
  const contextLimit = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0
    ? ctx.maxPages
    : HARD_MAX_PAGES;
  return Math.min(configured, contextLimit, HARD_MAX_PAGES);
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
    });
  }
  return jobs;
}

export default {
  id: 'icims',
  source: sourceMeta,
  capabilities: Object.freeze({
    listDescription: false,
    detail: true,
    importReady: true,
    providerDateFilter: false,
  }),
  detect(entry) {
    const origin = resolveIcimsOrigin(entry);
    return origin ? { url: introUrl(origin) } : null;
  },
  tenant(entry) {
    const origin = resolveIcimsOrigin(entry);
    return origin ? new URL(origin).hostname : null;
  },
  sourceOrigin(entry) {
    return resolveIcimsOrigin(entry);
  },
  async fetch(entry, ctx) {
    const origin = resolveIcimsOrigin(entry);
    if (!origin) throw new Error(`icims: cannot resolve portal for ${entry.name}`);

    const bootstrap = introUrl(origin);
    const bootstrapHtml = await ctx.fetchText(bootstrap, {
      redirect: 'error',
      headers: HEADERS,
    });
    let pageUrl = resolveIcimsSearchUrl(bootstrapHtml, origin);
    if (!pageUrl) {
      throw new Error(`icims: portal intro has no same-origin job search link for ${entry.name}`);
    }

    const all = [];
    const seenJobs = new Set();
    const seenPages = new Set();
    const limit = maxPages(entry, ctx);
    let referer = bootstrap;

    for (let page = 0; page < limit; page += 1) {
      if (seenPages.has(pageUrl)) break;
      seenPages.add(pageUrl);
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);

      const html = await ctx.fetchText(pageUrl, {
        redirect: 'error',
        headers: { ...HEADERS, referer },
      });
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
  },
};
