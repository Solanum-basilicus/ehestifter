import { htmlToPlainText } from './text.mjs';

function classTokens(openTag) {
  const value = openTag.match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1] ?? '';
  return value.split(/\s+/).filter(Boolean);
}

function closingTagStart(source, tagName, contentStart) {
  const token = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
  token.lastIndex = contentStart;
  let depth = 1;
  let match;
  while ((match = token.exec(source)) !== null) {
    if (match[0].startsWith('</')) depth -= 1;
    else if (!/\/\s*>$/.test(match[0])) depth += 1;
    if (depth === 0) return match.index;
  }
  return -1;
}

function classElements(source, tagName, classToken) {
  const openRe = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  const output = [];
  let match;
  while ((match = openRe.exec(source)) !== null) {
    if (!classTokens(match[0]).includes(classToken)) continue;
    const contentStart = openRe.lastIndex;
    const closeStart = closingTagStart(source, tagName, contentStart);
    if (closeStart < 0) continue;
    const closeEnd = source.indexOf('>', closeStart);
    if (closeEnd < 0) continue;
    output.push({
      start: match.index,
      end: closeEnd + 1,
      innerHtml: source.slice(contentStart, closeStart),
    });
  }
  return output;
}

function skipInterElementText(source, start) {
  let offset = start;
  while (offset < source.length) {
    const whitespace = source.slice(offset).match(/^\s+/)?.[0] ?? '';
    offset += whitespace.length;
    if (!source.startsWith('<!--', offset)) break;
    const end = source.indexOf('-->', offset + 4);
    if (end < 0) return source.length;
    offset = end + 3;
  }
  return offset;
}

function nextDivInnerHtml(source, start) {
  const offset = skipInterElementText(source, start);
  const open = /^<div\b[^>]*>/i.exec(source.slice(offset));
  if (!open) return '';
  const contentStart = offset + open[0].length;
  const closeStart = closingTagStart(source, 'div', contentStart);
  if (closeStart < 0) return '';
  return source.slice(contentStart, closeStart);
}

function sameJobApplyUrl(source, endpoint, expectedJobId) {
  const anchorRe = /<a\b([^>]*)>/gi;
  let match;
  while ((match = anchorRe.exec(source)) !== null) {
    const href = match[1].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      const parsed = new URL(href, endpoint);
      if (
        parsed.protocol === 'https:'
        && parsed.origin === endpoint.origin
        && parsed.search === ''
        && parsed.hash === ''
        && parsed.pathname.toLowerCase()
          === `/recruiting/jobs/apply/${expectedJobId}`.toLowerCase()
      ) return parsed.href;
    } catch {
      /* Ignore malformed links. */
    }
  }
  return null;
}

function remoteTypeFromLocation(value) {
  if (/\bhybrid\b/i.test(value)) return 'Hybrid';
  if (/\bremote\b/i.test(value)) return 'Remote';
  if (/\bon[ -]?site\b|\bin[ -]?office\b/i.test(value)) return 'On-site';
  return null;
}

/**
 * Parse the server-rendered Paylocity detail page when JobPosting JSON-LD is absent.
 */
export function parsePaylocityHtmlDetails(html, pageUrl, expectedJobId) {
  const source = String(html ?? '');
  if (!source || !/^\d+$/.test(String(expectedJobId ?? ''))) return null;

  const endpoint = pageUrl instanceof URL ? pageUrl : new URL(pageUrl);
  const titles = classElements(source, 'span', 'job-preview-title');
  if (titles.length !== 1 || !htmlToPlainText(titles[0].innerHtml)) return null;

  const descriptionHeaders = classElements(source, 'div', 'job-listing-header')
    .filter((item) => htmlToPlainText(item.innerHtml).toLowerCase() === 'description');
  if (descriptionHeaders.length !== 1) return null;

  const descriptionHtml = nextDivInnerHtml(source, descriptionHeaders[0].end);
  const description = htmlToPlainText(descriptionHtml);
  if (description.length < 20 || description.split(/\s+/).length < 3) return null;

  const applyUrl = sameJobApplyUrl(source, endpoint, String(expectedJobId));
  if (!applyUrl) return null;

  const locations = classElements(source, 'div', 'preview-location');
  if (locations.length > 1) return null;
  const rawLocation = locations.length === 1
    ? htmlToPlainText(locations[0].innerHtml).replace(/\s+/g, ' ').trim()
    : '';

  return {
    description,
    applyUrl,
    rawLocation: rawLocation || null,
    locations: [],
    remoteType: remoteTypeFromLocation(rawLocation),
  };
}
