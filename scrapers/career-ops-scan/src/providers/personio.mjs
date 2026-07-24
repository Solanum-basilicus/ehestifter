// Portions adapted from santifer/career-ops providers/personio.mjs.
// Upstream ref: f25570b3a5ecbaa18adf6ef6579e167ed3b68294 (MIT).

import { htmlToPlainText } from '../text/html.mjs';
import { providerSourceMeta } from './_source-meta.mjs';

const PERSONIO_HOST_RE = /^[a-z0-9][a-z0-9-]*\.jobs\.personio\.(de|com)$/;
const MAX_JOBS = 2000;

export const sourceMeta = providerSourceMeta({
  file: 'providers/personio.mjs',
  ref: 'f25570b3a5ecbaa18adf6ef6579e167ed3b68294',
  changes: [
    'balanced XML block extraction that ignores CDATA terminator-like text',
    'free description extraction from jobDescriptions',
    'explicit tenant() contract for Ehestifter target planning',
  ],
});

function resolveHost(entry) {
  const raw = entry.api || entry.careers_url || '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !PERSONIO_HOST_RE.test(parsed.hostname)) {
    return null;
  }
  return parsed.hostname.toLowerCase();
}

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function extractBlocks(xml, tagName) {
  if (typeof xml !== 'string' || xml === '') return [];
  const open = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  const close = new RegExp(`</${tagName}\\s*>`, 'gi');
  const blocks = [];
  let match;
  while ((match = open.exec(xml)) !== null) {
    const start = match.index;
    let cursor = open.lastIndex;
    let depth = 1;
    while (cursor < xml.length && depth > 0) {
      const cdata = xml.indexOf('<![CDATA[', cursor);
      const comment = xml.indexOf('<!--', cursor);
      open.lastIndex = cursor;
      close.lastIndex = cursor;
      const nestedOpen = open.exec(xml);
      const nestedClose = close.exec(xml);
      const candidates = [
        cdata >= 0 ? { type: 'cdata', index: cdata } : null,
        comment >= 0 ? { type: 'comment', index: comment } : null,
        nestedOpen ? { type: 'open', index: nestedOpen.index, end: open.lastIndex } : null,
        nestedClose ? { type: 'close', index: nestedClose.index, end: close.lastIndex } : null,
      ].filter(Boolean).sort((a, b) => a.index - b.index);
      if (candidates.length === 0) break;
      const next = candidates[0];
      if (next.type === 'cdata') {
        const end = xml.indexOf(']]>', next.index + 9);
        if (end < 0) break;
        cursor = end + 3;
      } else if (next.type === 'comment') {
        const end = xml.indexOf('-->', next.index + 4);
        if (end < 0) break;
        cursor = end + 3;
      } else if (next.type === 'open') {
        depth += 1;
        cursor = next.end;
      } else {
        depth -= 1;
        cursor = next.end;
        if (depth === 0) {
          blocks.push(xml.slice(start, cursor));
          open.lastIndex = cursor;
        }
      }
    }
    if (depth > 0) break;
  }
  return blocks;
}

function innerXml(block, tagName) {
  if (typeof block !== 'string') return '';
  const pattern = new RegExp(
    `<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}\\s*>`,
    'i',
  );
  return block.match(pattern)?.[1] ?? '';
}

function unwrapCdata(value) {
  const trimmed = String(value ?? '').trim();
  const cdata = trimmed.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return cdata ? cdata[1] : trimmed;
}

function xmlText(block, tagName) {
  return htmlToPlainText(unwrapCdata(innerXml(block, tagName)));
}

function personioDescription(positionBlock) {
  const descriptions = extractBlocks(
    innerXml(positionBlock, 'jobDescriptions'),
    'jobDescription',
  );
  const sections = [];
  for (const item of descriptions) {
    const heading = xmlText(item, 'name');
    const value = htmlToPlainText(unwrapCdata(innerXml(item, 'value')));
    if (!value) continue;
    sections.push(heading ? `${heading}\n${value}` : value);
  }
  return sections.join('\n\n').trim();
}

export function parsePersonioXml(xml, companyName, host) {
  if (!PERSONIO_HOST_RE.test(String(host ?? ''))) {
    throw new Error('personio: parser requires a validated Personio host');
  }
  const jobs = [];
  const seenIds = new Set();
  for (const block of extractBlocks(xml, 'position')) {
    const id = xmlText(block, 'id');
    const title = xmlText(block, 'name');
    if (!/^\d+$/.test(id) || !title || seenIds.has(id)) continue;
    seenIds.add(id);
    const offices = [];
    const officeSeen = new Set();
    for (const officeMatch of block.matchAll(
      /<office\b[^>]*>([\s\S]*?)<\/office\s*>/gi,
    )) {
      const office = htmlToPlainText(unwrapCdata(officeMatch[1]));
      const key = office.toLowerCase();
      if (office && !officeSeen.has(key)) {
        officeSeen.add(key);
        offices.push(office);
      }
    }
    const job = {
      id,
      title,
      url: `https://${host}/job/${id}`,
      company: companyName,
      location: offices.join(' / '),
    };
    const postedAt = toEpochMs(xmlText(block, 'createdAt'));
    if (postedAt !== undefined) job.postedAt = postedAt;
    const description = personioDescription(block);
    if (description) job.description = description;
    jobs.push(job);
    if (jobs.length >= MAX_JOBS) break;
  }
  return jobs;
}

export default {
  id: 'personio',
  source: sourceMeta,
  capabilities: Object.freeze({
    listDescription: true,
    detail: false,
    importReady: true,
    providerDateFilter: false,
  }),
  detect(entry) {
    const host = resolveHost(entry);
    return host ? { url: `https://${host}/xml` } : null;
  },
  tenant(entry) {
    const host = resolveHost(entry);
    return host ? host.split('.')[0] : null;
  },
  sourceOrigin(entry) {
    const host = resolveHost(entry);
    return host ? `https://${host}` : null;
  },
  async fetch(entry, ctx) {
    const host = resolveHost(entry);
    if (!host) throw new Error(`personio: cannot resolve feed for ${entry.name}`);
    const xml = await ctx.fetchText(`https://${host}/xml`, {
      redirect: 'error',
      headers: { accept: 'application/xml,text/xml' },
    });
    return parsePersonioXml(xml, entry.name, host);
  },
};
