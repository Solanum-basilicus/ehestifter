// Portions adapted from santifer/career-ops providers/softgarden.mjs.
// Upstream ref: 220288e93753933ceafe12f7bcb71ae6788bdeb0 (MIT).

import { decodeHtmlEntities, htmlToPlainText } from '../text/html.mjs';
import { providerSourceMeta } from './_source-meta.mjs';

const MAX_JOBS = 1000;
const SOFTGARDEN_HOST_RE = /^(?:[a-z0-9-]+\.)*softgarden\.io$/;

export const sourceMeta = providerSourceMeta({
  file: 'providers/softgarden.mjs',
  ref: '220288e93753933ceafe12f7bcb71ae6788bdeb0',
  changes: [
    'strict HTTPS-only widget resolution',
    'stable tenant derivation and source metadata',
    'parser hardening around duplicate ids and malformed links',
    'current vacancies-page parsing with legacy widget fallback and false-empty detection',
    'job-boundary checks for widget and vacancies-page location claims',
    'anchor-only fallback without unverified locations for changed HTML layouts',
  ],
});

function clean(value) {
  return htmlToPlainText(decodeHtmlEntities(String(value ?? '')));
}

export function resolveSoftgardenWidget(entry) {
  const raw = entry.api || entry.careers_url || '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !SOFTGARDEN_HOST_RE.test(parsed.hostname)) {
    return null;
  }
  if (/\/widgets\/jobs\/?$/i.test(parsed.pathname)) {
    parsed.pathname = parsed.pathname.replace(/\/$/, '');
    parsed.search = '';
    parsed.hash = '';
    return parsed;
  }
  const language = parsed.pathname.match(/^\/([a-z]{2})(?:\/|$)/i)?.[1] ?? 'de';
  parsed.pathname = `/${language.toLowerCase()}/widgets/jobs`;
  parsed.search = '';
  parsed.hash = '';
  return parsed;
}

export function parseSoftgardenDate(raw) {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  let month;
  let day;
  let year;
  const dot = value.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  const slash = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (dot) {
    day = Number(dot[1]);
    month = Number(dot[2]);
    year = Number(dot[3]);
  } else if (slash) {
    month = Number(slash[1]);
    day = Number(slash[2]);
    year = Number(slash[3]);
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
  ) {
    return undefined;
  }
  return result;
}

// Only read a job from a complete HTML element. A marker on one job must not
// collect locations from the next job when that job has no data-job-id marker.
const HTML_TAG_RE = /<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<\/?([a-z][\w:-]*)\b(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

function htmlAttribute(tag, name) {
  const pattern = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = tag.match(pattern);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function closedHtmlBlocks(html, select) {
  const openedByTag = new Map();
  const blocks = [];
  for (const match of html.matchAll(HTML_TAG_RE)) {
    if (!match[1]) continue;
    const tag = match[1].toLowerCase();
    if (match[0].startsWith('</')) {
      const opened = openedByTag.get(tag)?.pop();
      if (opened && select(opened.openingTag, tag)) {
        blocks.push({
          openingTag: opened.openingTag,
          html: html.slice(opened.start, match.index + match[0].length),
          start: opened.start,
        });
      }
    } else if (!VOID_TAGS.has(tag) && !/\/\s*>$/.test(match[0])) {
      if (!openedByTag.has(tag)) openedByTag.set(tag, []);
      openedByTag.get(tag).push({ start: match.index, openingTag: match[0] });
    }
  }
  return blocks.sort((left, right) => left.start - right.start);
}

function hasOtherJobLinks(block, expectedId) {
  for (const anchor of block.matchAll(/<a\b[^>]*>/gi)) {
    const href = htmlAttribute(anchor[0], 'href');
    const id = href?.match(/\/job\/(\d+)(?:\/|[?#]|$)/i)?.[1];
    if (id && id !== expectedId) return true;
  }
  return false;
}

// When no safe job block exists, keep only the job link and its visible title.
// Do not infer a work location from adjacent page text or other job links.
function anchorOnlyJobs(html, base, acquisitionMode) {
  const visibleHtml = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  const jobs = [];
  const seen = new Set();
  for (const anchor of visibleHtml.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = htmlAttribute(anchor[1], 'href');
    if (!href) continue;
    let url;
    try {
      url = new URL(decodeHtmlEntities(href), base);
    } catch {
      continue;
    }
    if (!sameSoftgardenOrigin(url, base)) continue;
    const id = url.pathname.match(/^\/job\/(\d+)(?:\/|$)/i)?.[1];
    if (!id || seen.has(id)) continue;
    const title = clean(anchor[2]);
    if (!title) continue;
    jobs.push({ id, title, url: url.href, company: '', location: '', acquisitionMode });
    seen.add(id);
    if (jobs.length >= MAX_JOBS) break;
  }
  return jobs;
}

export function parseSoftgardenWidget(html, widgetUrl) {
  if (typeof html !== 'string') return [];
  const base = widgetUrl instanceof URL ? widgetUrl : new URL(widgetUrl);
  const jobs = [];
  const seen = new Set();
  const blocks = closedHtmlBlocks(
    html,
    (openingTag) => htmlAttribute(openingTag, 'data-job-id') !== null,
  );

  for (const { openingTag, html: block } of blocks) {
    const id = htmlAttribute(openingTag, 'data-job-id') ?? '';
    if (!id || seen.has(id) || hasOtherJobLinks(block, id)) continue;

    const links = [...block.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
    let selected = null;
    for (const link of links) {
      const href = htmlAttribute(link[1], 'href');
      if (!href) continue;
      const className = htmlAttribute(link[1], 'class') ?? '';
      if (/job-title|jobTitle/i.test(className) || /\/job\//i.test(href)) {
        selected = { href, titleHtml: link[2] };
        break;
      }
    }
    if (!selected) continue;
    const title = clean(selected.titleHtml);
    if (!title) continue;

    let url;
    try {
      const resolved = new URL(decodeHtmlEntities(selected.href), base);
      if (resolved.protocol !== 'https:' || resolved.origin !== base.origin) continue;
      url = resolved.href;
    } catch {
      continue;
    }

    const locations = [];
    const locationSeen = new Set();
    for (const match of block.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi)) {
      const className = htmlAttribute(match[1], 'class') ?? '';
      if (!/(?:^|\s)location-view-item(?:\s|$)/i.test(className)) continue;
      const location = clean(match[2]);
      const key = location.toLowerCase();
      if (location && !locationSeen.has(key)) {
        locationSeen.add(key);
        locations.push(location);
      }
    }

    const date = clean(
      block.match(/class="[^"]*\bmatchValue\b[^"]*\bdate\b[^"]*"[^>]*>([\s\S]*?)<\//i)?.[1]
      ?? block.match(/class="[^"]*\bdate\b[^"]*\bmatchValue\b[^"]*"[^>]*>([\s\S]*?)<\//i)?.[1]
      ?? '',
    );
    const job = {
      id,
      title,
      url,
      company: '',
      location: locations.join(' / '),
    };
    const postedAt = parseSoftgardenDate(date);
    if (postedAt !== undefined) job.postedAt = postedAt;
    jobs.push(job);
    seen.add(id);
    if (jobs.length >= MAX_JOBS) break;
  }
  // Real widget markup can contain incomplete or changed job containers.
  // A missing close tag must not remove an otherwise valid job link.
  return jobs.length > 0 ? jobs : anchorOnlyJobs(html, base, 'legacy-widget-anchors');
}



function sameSoftgardenOrigin(url, base) {
  return url.protocol === 'https:'
    && url.origin === base.origin
    && SOFTGARDEN_HOST_RE.test(url.hostname);
}

function parseJobAnchor(block, base) {
  const anchorRe = /<a\b([^>]*\bhref=["']([^"']*\/job\/(\d+)(?:\/[^"']*)?)["'][^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(block)) !== null) {
    const title = clean(match[4]);
    if (!title) continue;
    try {
      const url = new URL(decodeHtmlEntities(match[2]), base);
      if (!sameSoftgardenOrigin(url, base)) continue;
      return { id: match[3], title, url: url.href };
    } catch {
      continue;
    }
  }
  return null;
}

function rowValues(block) {
  return [...block.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
    .map((match) => clean(match[1]))
    .filter(Boolean);
}

function explicitLocation(block) {
  const patterns = [
    /class=["'][^"']*\blocation-view-item\b[^"']*["'][^>]*>([\s\S]*?)<\//gi,
    /class=["'][^"']*\b(?:job-)?location\b[^"']*["'][^>]*>([\s\S]*?)<\//gi,
    /data-field=["']location["'][^>]*>([\s\S]*?)<\//gi,
  ];
  for (const pattern of patterns) {
    const values = [];
    const seen = new Set();
    let match;
    while ((match = pattern.exec(block)) !== null) {
      const value = clean(match[1]);
      const key = value.toLowerCase();
      if (value && !seen.has(key)) {
        seen.add(key);
        values.push(value);
      }
    }
    if (values.length > 0) return values.join(' / ');
  }
  return '';
}

function jobFromVacancyBlock(block, base) {
  const anchor = parseJobAnchor(block, base);
  if (!anchor) return null;
  const values = rowValues(block);
  const dateValue = values.find((value) => parseSoftgardenDate(value) !== undefined)
    ?? clean(block.match(/\b(?:date|posted)[^>]*>([\s\S]*?)<\//i)?.[1] ?? '');
  let location = explicitLocation(block);
  if (!location && values.length > 0) {
    const candidates = values.filter((value) => (
      value !== anchor.title
      && parseSoftgardenDate(value) === undefined
    ));
    location = candidates.at(-1) ?? '';
  }
  const job = {
    id: anchor.id,
    title: anchor.title,
    url: anchor.url,
    company: '',
    location,
  };
  const postedAt = parseSoftgardenDate(dateValue);
  if (postedAt !== undefined) job.postedAt = postedAt;
  return job;
}

export function parseSoftgardenVacanciesPage(html, pageUrl) {
  if (typeof html !== 'string') return [];
  const base = pageUrl instanceof URL ? pageUrl : new URL(pageUrl);
  const jobs = [];
  const seen = new Set();
  const rows = closedHtmlBlocks(html, (_, tag) => tag === 'tr');
  for (const { html: row } of rows) {
    const job = jobFromVacancyBlock(row, base);
    if (!job || seen.has(job.id) || hasOtherJobLinks(row, job.id)) continue;
    seen.add(job.id);
    jobs.push(job);
    if (jobs.length >= MAX_JOBS) return jobs;
  }
  if (jobs.length > 0) return jobs;

  // Use only closed list items and articles. A window around an anchor can
  // include the locations of adjacent vacancies on a large tenant board.
  const blocks = closedHtmlBlocks(
    html,
    (_, tag) => tag === 'li' || tag === 'article',
  );
  for (const { html: block } of blocks) {
    const job = jobFromVacancyBlock(block, base);
    if (!job || seen.has(job.id) || hasOtherJobLinks(block, job.id)) continue;
    seen.add(job.id);
    jobs.push(job);
    if (jobs.length >= MAX_JOBS) break;
  }
  // Use links only if no row, list item, or article has a safe boundary.
  // An ungrouped link provides no reliable listing-level location.
  return jobs.length > 0 ? jobs : anchorOnlyJobs(html, base, 'vacancies-page-anchors');
}

function resolveSoftgardenPage(entry) {
  const raw = entry.careers_url || entry.api || '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !SOFTGARDEN_HOST_RE.test(parsed.hostname)) {
    return null;
  }
  parsed.search = '';
  parsed.hash = '';
  if (/\/widgets\/jobs\/?$/i.test(parsed.pathname)) return null;
  if (parsed.pathname === '/' || parsed.pathname === '') {
    parsed.pathname = '/';
  }
  return parsed;
}

export default {
  id: 'softgarden',
  source: sourceMeta,
  capabilities: Object.freeze({
    listDescription: false,
    detail: true,
    importReady: true,
    providerDateFilter: false,
  }),
  detect(entry) {
    const widget = resolveSoftgardenWidget(entry);
    return widget ? { url: widget.href } : null;
  },
  tenant(entry) {
    const widget = resolveSoftgardenWidget(entry);
    if (!widget) return null;
    const labels = widget.hostname.split('.');
    return labels.length > 2 ? labels[0] : widget.hostname;
  },
  sourceOrigin(entry) {
    const widget = resolveSoftgardenWidget(entry);
    return widget ? widget.origin : null;
  },
  async fetch(entry, ctx) {
    const widget = resolveSoftgardenWidget(entry);
    if (!widget) throw new Error(`softgarden: cannot resolve widget for ${entry.name}`);
    const page = resolveSoftgardenPage(entry);
    let pageHtml = null;
    let pageError = null;
    if (page) {
      try {
        pageHtml = await ctx.fetchText(page, {
          redirect: 'follow',
          headers: { accept: 'text/html,application/xhtml+xml' },
        });
        const pageJobs = parseSoftgardenVacanciesPage(pageHtml, page);
        if (pageJobs.length > 0) {
          ctx.reportProviderTelemetry?.({ acquisitionMode: pageJobs[0].acquisitionMode ?? 'vacancies-page' });
          return pageJobs.map((job) => ({ ...job, company: entry.name }));
        }
      } catch (error) {
        pageError = error;
      }
    }

    ctx.reportProviderTelemetry?.({ acquisitionMode: 'legacy-widget' });
    const widgetHtml = await ctx.fetchText(widget, {
      redirect: 'error',
      headers: { accept: 'text/html' },
    });
    const widgetJobs = parseSoftgardenWidget(widgetHtml, widget);
    if (widgetJobs[0]?.acquisitionMode) {
      ctx.reportProviderTelemetry?.({ acquisitionMode: widgetJobs[0].acquisitionMode });
    }
    if (widgetJobs.length === 0 && /\/job\/\d+/i.test(widgetHtml)) {
      const error = new Error('softgarden: widget_schema_mismatch');
      error.code = 'SOFTGARDEN_WIDGET_SCHEMA_MISMATCH';
      throw error;
    }
    if (widgetJobs.length === 0 && pageError) throw pageError;
    if (widgetJobs.length === 0 && /\/job\/\d+/i.test(pageHtml ?? '')) {
      const error = new Error('softgarden: listing_schema_mismatch');
      error.code = 'SOFTGARDEN_LISTING_SCHEMA_MISMATCH';
      throw error;
    }
    return widgetJobs.map((job) => ({
      ...job,
      company: entry.name,
    }));
  },
};
