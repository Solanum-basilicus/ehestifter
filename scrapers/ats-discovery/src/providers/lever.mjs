// Portions derived from santifer/career-ops at 493487462608c0cced82c1440e7ba8be6c01f306.
// Originally distributed under the MIT License.
// Modified for Ehestifter. See THIRD_PARTY_NOTICES.md.

// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { htmlToPlainText } from '../text/html.mjs';

// Lever provider — hits the public postings endpoint.
// Auto-detects from careers_url via jobs.(eu.)?lever.co/<slug>.
// Handles both explicit `api:` URLs and auto-detection from `careers_url`.

const ALLOWED_LEVER_HOSTS = new Set(['api.lever.co', 'api.eu.lever.co']);

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : '';
}

/** @param {...unknown} values */
function joinSections(...values) {
  return values
    .map(nonEmptyString)
    .filter(Boolean)
    .join('\n\n');
}

/** @param {unknown} value */
function leverHtmlToPlainText(value) {
  return htmlToPlainText(value)
    .replace(/\n{2,}(?=- )/g, '\n')
    .replace(/[ \t]+([,.;:!?])/g, '$1');
}

/** @param {unknown} plain @param {unknown} html */
function preferPlainText(plain, html) {
  return nonEmptyString(plain) || leverHtmlToPlainText(html);
}

/**
 * Lever's list and single-posting APIs split the rendered posting across the
 * combined opening/body, structured lists, and optional closing content.
 * Compose those fields once at the provider boundary so all downstream scan,
 * filtering, remote inference, and import paths see the complete plain text.
 *
 * @param {any} posting
 */
export function composeLeverDescription(posting) {
  if (!posting || typeof posting !== 'object' || Array.isArray(posting)) {
    return '';
  }

  const main = nonEmptyString(posting.descriptionPlain) || joinSections(
    preferPlainText(posting.openingPlain, posting.opening),
    preferPlainText(posting.descriptionBodyPlain, posting.descriptionBody),
  );

  const lists = Array.isArray(posting.lists)
    ? posting.lists.map((list) => {
      if (!list || typeof list !== 'object' || Array.isArray(list)) return '';
      return joinSections(
        leverHtmlToPlainText(list.text),
        leverHtmlToPlainText(list.content),
      );
    })
    : [];

  const additional = preferPlainText(
    posting.additionalPlain,
    posting.additional,
  );

  return joinSections(main, ...lists, additional);
}

/** @param {string} url */
function assertLeverUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`lever: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`lever: URL must use HTTPS: ${url}`);
  if (!ALLOWED_LEVER_HOSTS.has(parsed.hostname))
    throw new Error(`lever: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_LEVER_HOSTS].join(', ')}`);
  return url;
}

/** @param {import('./_types.js').PortalEntry} entry */
function resolveApiUrl(entry) {
  // Explicit api: wins — lets an entry keep a human-facing corporate
  // careers_url (e.g. https://www.coalfire.com/careers) while still pinning
  // the Lever postings board (mirrors greenhouse's api: precedence).
  if (entry.api) {
    assertLeverUrl(entry.api);
    return entry.api;
  }
  let url;
  try {
    url = new URL(entry.careers_url || '');
  } catch {
    return null;
  }
  const host = url.hostname.match(/^jobs\.((?:eu\.)?lever\.co)$/);
  if (!host) return null;
  const slug = url.pathname.split('/').filter(Boolean)[0];
  if (!slug) return null;
  return `https://api.${host[1]}/v0/postings/${slug}`;
}

/** @type {Provider} */
export default {
  id: 'lever',

  detect(entry) {
    try {
      const apiUrl = resolveApiUrl(entry);
      return apiUrl ? { url: apiUrl } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`lever: cannot derive API URL for ${entry.name}`);
    assertLeverUrl(apiUrl);
    const json = await ctx.fetchJson(apiUrl, { redirect: 'error' });
    if (!Array.isArray(json)) return [];
    return json.map(j => ({
      title: j.text || '',
      url: j.hostedUrl || '',
      company: entry.name,
      location: j.categories?.location || '',
      // The list payload contains every rendered description segment, so no
      // per-job request is required for complete Lever content.
      description: composeLeverDescription(j),
      postedAt: typeof j.createdAt === 'number' ? j.createdAt : undefined,
    }));
  },
};
