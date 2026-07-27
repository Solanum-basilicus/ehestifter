// Portions derived from santifer/career-ops at
// 493487462608c0cced82c1440e7ba8be6c01f306 (MIT).
// Modified for Ehestifter. See THIRD_PARTY_NOTICES.md.

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; career-ops/1.3)';
const DEFAULT_MAX_RESPONSE_BYTES = 20_000_000;
const MAX_ERROR_BODY_BYTES = 65_536;

export const BROWSER_LIKE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/131.0.0.0 Safari/537.36';

function splitCombinedSetCookie(value) {
  if (!value) return [];
  // A Set-Cookie header may be comma-combined by test doubles. Expires is the
  // only common attribute containing a comma, so avoid splitting inside it.
  const output = [];
  let start = 0;
  let inExpires = false;
  const lower = value.toLowerCase();
  for (let index = 0; index < value.length; index += 1) {
    if (lower.startsWith('expires=', index)) inExpires = true;
    const char = value[index];
    if (inExpires && char === ';') inExpires = false;
    if (!inExpires && char === ',') {
      const rest = value.slice(index + 1);
      if (/^\s*[^=;,\s]+\s*=/.test(rest)) {
        output.push(value.slice(start, index).trim());
        start = index + 1;
      }
    }
  }
  output.push(value.slice(start).trim());
  return output.filter(Boolean);
}

function responseSetCookies(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function') {
    const values = headers.getSetCookie();
    if (Array.isArray(values) && values.length > 0) {
      return values.flatMap((value) => splitCombinedSetCookie(value));
    }
  }
  return splitCombinedSetCookie(headers.get?.('set-cookie'));
}

function cookiePair(setCookie) {
  const first = String(setCookie ?? '').split(';', 1)[0].trim();
  const separator = first.indexOf('=');
  if (separator <= 0) return null;
  const name = first.slice(0, separator).trim();
  const value = first.slice(separator + 1).trim();
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) return null;
  return { name, value };
}

function mergeHeaders(...values) {
  const merged = new Headers();
  for (const value of values) {
    if (!value) continue;
    for (const [name, headerValue] of new Headers(value).entries()) {
      merged.set(name, headerValue);
    }
  }
  return merged;
}

async function boundedBytes(response, maximum, label) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maximum) {
    throw new Error(`${label} exceeds ${maximum} bytes`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximum) {
    throw new Error(`${label} exceeds ${maximum} bytes`);
  }
  return bytes;
}

function httpError(response, responseText) {
  const statusText = response.statusText ? ` ${response.statusText}` : '';
  const error = new Error(`HTTP ${response.status}${statusText}`);
  error.status = response.status;
  error.body = responseText;
  error.retryAfter = response.headers?.get?.('retry-after') ?? null;
  return error;
}

export function createHttpSession({
  fetchImpl = fetch,
  timeoutMs: defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  userAgent = DEFAULT_USER_AGENT,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl must be a function');
  const cookiesByOrigin = new Map();

  function cookieHeader(url) {
    const jar = cookiesByOrigin.get(new URL(url).origin);
    if (!jar || jar.size === 0) return null;
    return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  function absorbCookies(url, response) {
    const values = responseSetCookies(response.headers);
    if (values.length === 0) return;
    const origin = new URL(url).origin;
    if (!cookiesByOrigin.has(origin)) cookiesByOrigin.set(origin, new Map());
    const jar = cookiesByOrigin.get(origin);
    for (const value of values) {
      const pair = cookiePair(value);
      if (!pair) continue;
      if (pair.value === '') jar.delete(pair.name);
      else jar.set(pair.name, pair.value);
    }
  }

  async function request(url, {
    timeoutMs = defaultTimeoutMs,
    headers = {},
    method = 'GET',
    body = null,
    redirect = 'follow',
  } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const cookie = cookieHeader(url);
      const mergedHeaders = mergeHeaders(
        { 'user-agent': userAgent },
        cookie ? { cookie } : null,
        headers,
      );
      const response = await fetchImpl(url, {
        method,
        headers: mergedHeaders,
        body,
        redirect,
        signal: controller.signal,
      });
      absorbCookies(response.url || url, response);
      if (!response.ok) {
        let responseText = '';
        try {
          responseText = (
            await boundedBytes(response, MAX_ERROR_BODY_BYTES, 'HTTP error response')
          ).toString('utf8');
        } catch (error) {
          responseText = error instanceof Error ? error.message : String(error);
        }
        throw httpError(response, responseText);
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchText(url, options = {}) {
    const response = await request(url, options);
    return (
      await boundedBytes(response, maxResponseBytes, 'HTTP text response')
    ).toString('utf8');
  }

  async function fetchJson(url, options = {}) {
    const response = await request(url, options);
    const bytes = await boundedBytes(response, maxResponseBytes, 'HTTP JSON response');
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      throw new Error('HTTP endpoint returned invalid JSON', { cause: error });
    }
  }

  return Object.freeze({
    transport: 'http',
    fetchText,
    fetchJson,
  });
}

export async function fetchText(url, options = {}) {
  return createHttpSession().fetchText(url, options);
}

export async function fetchJson(url, options = {}) {
  return createHttpSession().fetchJson(url, options);
}

export function makeHttpCtx(options = {}) {
  return createHttpSession(options);
}
