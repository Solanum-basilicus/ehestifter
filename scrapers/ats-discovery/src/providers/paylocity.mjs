// Portions adapted from kalil0321/ats-scrapers Paylocity scraper.
// Upstream ref: 83a694a80679d49376b76e31fccd5676cddf9cd1 (MIT).

import { BROWSER_LIKE_USER_AGENT } from './_http.mjs';

const PAYLOCITY_ORIGIN = 'https://recruiting.paylocity.com';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_DATA_RE = /\bwindow\.pageData\s*=\s*/g;

export const sourceMeta = Object.freeze({
  repository: 'kalil0321/ats-scrapers',
  file: 'src/ats_scrapers/scrapers/paylocity.py',
  ref: '83a694a80679d49376b76e31fccd5676cddf9cd1',
  license: 'MIT',
  changes: Object.freeze([
    'plain ESM adapter for the Ehestifter provider contract',
    'listing-only acquisition with the shared Ehestifter detail stage',
    'explicit board-id identity because public detail URLs omit the board id',
  ]),
});

function normalizeUuid(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return UUID_RE.test(text) ? text : null;
}

export function resolvePaylocityBoard(entry) {
  for (const raw of [entry.api, entry.careers_url]) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    let parsed;
    try {
      parsed = new URL(raw.trim());
    } catch {
      continue;
    }
    if (
      parsed.protocol !== 'https:'
      || parsed.hostname !== 'recruiting.paylocity.com'
      || parsed.username
      || parsed.password
      || (parsed.port && parsed.port !== '443')
      || parsed.search
      || parsed.hash
    ) continue;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (
      segments.length !== 4
      || segments.slice(0, 3).map((item) => item.toLowerCase()).join('/') !== 'recruiting/jobs/all'
    ) continue;
    const boardId = normalizeUuid(segments[3]);
    if (!boardId) continue;
    return {
      boardId,
      listingUrl: `${PAYLOCITY_ORIGIN}/Recruiting/Jobs/All/${boardId}`,
    };
  }
  return null;
}

function extractJsonObject(source, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let begin = -1;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (begin < 0) {
      if (/\s/.test(char)) continue;
      if (char !== '{') throw new Error('paylocity: pageData must start with an object');
      begin = index;
      depth = 1;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return { text: source.slice(begin, index + 1), end: index + 1 };
    }
  }
  throw new Error('paylocity: pageData object is incomplete');
}

export function extractPaylocityPageData(html) {
  const source = String(html ?? '');
  PAGE_DATA_RE.lastIndex = 0;
  const matches = [...source.matchAll(PAGE_DATA_RE)];
  if (matches.length !== 1) {
    throw new Error('paylocity: listing must contain one window.pageData payload');
  }
  const start = (matches[0].index ?? 0) + matches[0][0].length;
  const extracted = extractJsonObject(source, start);
  if (!source.slice(extracted.end).trimStart().startsWith(';')) {
    throw new Error('paylocity: pageData payload is not terminated');
  }
  let payload;
  try {
    payload = JSON.parse(extracted.text);
  } catch (error) {
    throw new Error('paylocity: pageData payload is invalid JSON', { cause: error });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('paylocity: pageData payload must be an object');
  }
  return payload;
}

function text(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || typeof value === 'boolean') return '';
  return String(value).trim();
}

function jobId(value) {
  const normalized = text(value);
  return /^[1-9]\d*$/.test(normalized) ? normalized : null;
}

function locationText(row) {
  const location = row?.JobLocation;
  if (!location || typeof location !== 'object' || Array.isArray(location)) {
    return text(row?.LocationName);
  }
  const parts = [location.City || location.Metro, location.State, location.Country]
    .map(text)
    .filter(Boolean);
  return [...new Set(parts)].join(', ') || text(row?.LocationName);
}

function toEpochMs(value) {
  const raw = text(value);
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function parsePaylocityListing(payload, entry, boardId) {
  if (!Array.isArray(payload?.Jobs)) {
    throw new Error(`paylocity: board ${boardId} omitted the Jobs list`);
  }
  const jobs = [];
  const seen = new Set();
  for (let index = 0; index < payload.Jobs.length; index += 1) {
    const row = payload.Jobs[index];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`paylocity: listing row ${index} is not an object`);
    }
    if (typeof row.IsInternal !== 'boolean') {
      throw new Error(`paylocity: listing row ${index} omitted IsInternal`);
    }
    if (row.IsInternal) continue;
    const id = jobId(row.JobId);
    if (!id) throw new Error(`paylocity: listing row ${index} has an invalid JobId`);
    if (seen.has(id)) throw new Error(`paylocity: listing has duplicate JobId ${id}`);
    const title = text(row.JobTitle);
    if (!title) throw new Error(`paylocity: listing row ${index} omitted JobTitle`);
    seen.add(id);
    jobs.push({
      id,
      title,
      url: `${PAYLOCITY_ORIGIN}/Recruiting/Jobs/Details/${id}`,
      company: text(entry.name) || text(payload.ModuleTitle) || boardId,
      location: locationText(row),
      postedAt: toEpochMs(row.PublishedDate),
    });
  }
  return jobs;
}

export default {
  id: 'paylocity',
  source: sourceMeta,
  capabilities: Object.freeze({
    listDescription: false,
    detail: true,
    importReady: true,
    providerDateFilter: false,
    explicitIdentityPreflight: true,
  }),
  detect(entry) {
    const board = resolvePaylocityBoard(entry);
    return board ? { url: board.listingUrl } : null;
  },
  tenant(entry) {
    return resolvePaylocityBoard(entry)?.boardId ?? null;
  },
  sourceOrigin(entry) {
    return resolvePaylocityBoard(entry) ? PAYLOCITY_ORIGIN : null;
  },
  async fetch(entry, ctx) {
    const board = resolvePaylocityBoard(entry);
    if (!board) throw new Error(`paylocity: cannot resolve board for ${entry.name}`);
    const html = await ctx.fetchText(board.listingUrl, {
      redirect: 'error',
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': BROWSER_LIKE_USER_AGENT,
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    return parsePaylocityListing(extractPaylocityPageData(html), entry, board.boardId);
  },
};
