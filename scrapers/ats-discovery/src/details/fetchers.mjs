import { parseJobPostingJsonLd } from './jobposting-jsonld.mjs';
import { htmlToPlainText } from './text.mjs';
import { greenhouseHtmlToPlainText } from './greenhouse-text.mjs';
import {
  createHttpSession,
  BROWSER_LIKE_USER_AGENT,
} from '../providers/_http.mjs';
import {
  assertPublicHttpsUrl,
  sameOrigin,
} from '../providers/_url-safety.mjs';

const GREENHOUSE_HOST = 'boards-api.greenhouse.io';
const ASHBY_HOST = 'api.ashbyhq.com';
const SMARTRECRUITERS_HOST = 'api.smartrecruiters.com';
const SOFTGARDEN_HOST_RE = /^(?:[a-z0-9-]+\.)*softgarden\.io$/;
const MAX_DETAIL_BYTES = 5_000_000;

function safeProgress(onProgress, value) {
  if (!onProgress) return;
  try {
    onProgress(value);
  } catch {
    /* Progress is diagnostic and must not affect detail fetching. */
  }
}

function mapLimit(items, limit, worker, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let completed = 0;
  async function consume() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
      completed += 1;
      safeProgress(onProgress, {
        stage: 'details',
        current: completed,
        total: items.length,
      });
    }
  }
  return Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => consume()),
  ).then(() => results);
}

async function responseBytes(response, label) {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_DETAIL_BYTES) {
    throw new Error(`${label} exceeds ${MAX_DETAIL_BYTES} bytes`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_DETAIL_BYTES) {
    throw new Error(`${label} exceeds ${MAX_DETAIL_BYTES} bytes`);
  }
  return buffer;
}

async function fetchWithTimeout({
  fetchImpl,
  url,
  timeoutMs,
  accept,
  options = {},
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      ...options,
      signal: controller.signal,
      headers: {
        accept,
        ...(options.headers ?? {}),
      },
    });
    if (!response.ok) {
      let body = '';
      try {
        body = (await responseBytes(response, 'Detail error response')).toString('utf8');
      } catch (error) {
        throw new Error(`Detail endpoint returned ${response.status}: ${error.message}`);
      }
      throw new Error(
        `Detail endpoint returned ${response.status}: ${body.slice(0, 500)}`,
      );
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithTimeout(args) {
  const response = await fetchWithTimeout({
    ...args,
    accept: 'application/json',
  });
  const bytes = await responseBytes(response, 'Detail JSON response');
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error('Detail endpoint returned invalid JSON', { cause: error });
  }
}

async function fetchTextWithTimeout(args) {
  const response = await fetchWithTimeout({
    ...args,
    accept: 'text/html,application/xhtml+xml',
  });
  return (await responseBytes(response, 'Detail HTML response')).toString('utf8');
}

function assertEndpointHost(endpoint, expectedHost) {
  if (endpoint.protocol !== 'https:') {
    throw new Error(`Detail URL must use HTTPS: ${endpoint}`);
  }
  if (endpoint.hostname !== expectedHost) {
    throw new Error(
      `Unexpected detail endpoint host ${endpoint.hostname}; expected ${expectedHost}`,
    );
  }
}

function safeApplyUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function normalizeRemoteType(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  if (normalized === 'remote') return 'Remote';
  if (normalized === 'hybrid') return 'Hybrid';
  if (normalized === 'onsite' || normalized === 'inoffice') return 'On-site';
  return null;
}

function normalizedLocation(location) {
  if (!location || typeof location !== 'object') return [];
  const countryName = typeof location.country === 'string'
    ? location.country.trim()
    : '';
  if (!countryName) return [];
  return [{
    countryName,
    countryCode: null,
    cityName: typeof location.city === 'string'
      ? location.city.trim() || null
      : null,
    region: typeof location.region === 'string'
      ? location.region.trim() || null
      : null,
  }];
}

function ashbyLocations(job) {
  const postal = job?.address?.postalAddress;
  if (
    !postal
    || typeof postal.addressCountry !== 'string'
    || postal.addressCountry.trim() === ''
  ) return [];
  return [{
    countryName: postal.addressCountry.trim(),
    countryCode: null,
    cityName: typeof postal.addressLocality === 'string'
      ? postal.addressLocality.trim() || null
      : null,
    region: typeof postal.addressRegion === 'string'
      ? postal.addressRegion.trim() || null
      : null,
  }];
}

function sourceIdentity(candidate) {
  return {
    tenant: candidate.sourceTenant
      || candidate.canonicalIdentity?.providerTenant
      || null,
    externalId: candidate.provenance?.providerNativeId
      || candidate.canonicalIdentity?.externalId
      || null,
  };
}

async function fetchGreenhouseDetails(candidate, context) {
  const { tenant, externalId } = sourceIdentity(candidate);
  if (!tenant || !externalId) {
    throw new Error('Greenhouse detail fetch requires source tenant and externalId');
  }
  const endpoint = new URL(
    `https://${GREENHOUSE_HOST}/v1/boards/${encodeURIComponent(tenant)}`
    + `/jobs/${encodeURIComponent(externalId)}`,
  );
  assertEndpointHost(endpoint, GREENHOUSE_HOST);
  const payload = await fetchJsonWithTimeout({
    fetchImpl: context.fetchImpl,
    url: endpoint,
    timeoutMs: context.timeoutMs,
  });
  return {
    description: greenhouseHtmlToPlainText(payload.content),
    descriptionStatus: 'greenhouse-detail-api',
    applyUrl: typeof payload.absolute_url === 'string'
      ? payload.absolute_url.trim()
      : null,
    rawLocation: typeof payload.location?.name === 'string'
      ? payload.location.name.trim() || null
      : null,
    locations: [],
    remoteType: null,
  };
}

async function fetchAshbyBoard(tenant, context) {
  const endpoint = new URL(
    `https://${ASHBY_HOST}/posting-api/job-board/${encodeURIComponent(tenant)}`,
  );
  endpoint.searchParams.set('includeCompensation', 'true');
  assertEndpointHost(endpoint, ASHBY_HOST);
  const cacheKey = endpoint.toString();
  if (!context.ashbyBoardCache.has(cacheKey)) {
    context.ashbyBoardCache.set(
      cacheKey,
      fetchJsonWithTimeout({
        fetchImpl: context.fetchImpl,
        url: endpoint,
        timeoutMs: context.timeoutMs,
      }),
    );
  }
  return context.ashbyBoardCache.get(cacheKey);
}

async function fetchAshbyDetails(candidate, context) {
  const { tenant, externalId } = sourceIdentity(candidate);
  if (!tenant || !externalId) {
    throw new Error('Ashby detail fetch requires source tenant and externalId');
  }
  const payload = await fetchAshbyBoard(tenant, context);
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  const job = jobs.find((item) => String(item?.id ?? '') === String(externalId));
  if (!job) {
    throw new Error(`Ashby job ${externalId} was not present on board ${tenant}`);
  }
  const plain = typeof job.descriptionPlain === 'string'
    ? job.descriptionPlain.trim()
    : '';
  return {
    description: plain || htmlToPlainText(job.descriptionHtml),
    descriptionStatus: 'ashby-board-api',
    applyUrl: typeof job.applyUrl === 'string' ? job.applyUrl.trim() : null,
    locations: ashbyLocations(job),
    remoteType: normalizeRemoteType(job.workplaceType),
  };
}

function smartRecruitersDescription(payload) {
  const sections = payload?.jobAd?.sections;
  if (!sections || typeof sections !== 'object') return '';
  const preferred = [
    'companyDescription',
    'jobDescription',
    'qualifications',
    'additionalInformation',
  ];
  const keys = [
    ...preferred.filter((key) => sections[key] != null),
    ...Object.keys(sections).filter((key) => !preferred.includes(key)).sort(),
  ];
  const output = [];
  for (const key of keys) {
    const section = sections[key];
    if (!section || typeof section !== 'object') continue;
    const text = htmlToPlainText(section.text ?? section.description ?? '');
    if (!text) continue;
    const title = htmlToPlainText(section.title ?? '');
    output.push(title ? `${title}\n${text}` : text);
  }
  return output.join('\n\n').trim();
}

async function fetchSmartRecruitersDetails(candidate, context) {
  const { tenant, externalId } = sourceIdentity(candidate);
  if (!tenant || !externalId) {
    throw new Error('SmartRecruiters detail fetch requires source tenant and externalId');
  }
  const endpoint = new URL(
    `https://${SMARTRECRUITERS_HOST}/v1/companies/${encodeURIComponent(tenant)}`
    + `/postings/${encodeURIComponent(externalId)}`,
  );
  assertEndpointHost(endpoint, SMARTRECRUITERS_HOST);
  const payload = await fetchJsonWithTimeout({
    fetchImpl: context.fetchImpl,
    url: endpoint,
    timeoutMs: context.timeoutMs,
  });
  return {
    description: smartRecruitersDescription(payload),
    descriptionStatus: 'smartrecruiters-detail-api',
    applyUrl: typeof payload.applyUrl === 'string' ? payload.applyUrl.trim() : null,
    locations: normalizedLocation(payload.location),
    remoteType: payload.location?.remote ? 'Remote' : null,
  };
}


function closingTagIndex(source, tagName, contentStart) {
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

function markedElementHtml(source, markerRe) {
  const startRe = /<([a-z][\w:-]*)\b[^>]*>/gi;
  let match;
  while ((match = startRe.exec(source)) !== null) {
    if (!markerRe.test(match[0])) continue;
    markerRe.lastIndex = 0;
    const end = closingTagIndex(source, match[1], startRe.lastIndex);
    if (end < 0) continue;
    return source.slice(startRe.lastIndex, end);
  }
  return '';
}

function successFactorsDescriptionHtml(html) {
  const source = String(html ?? '');
  const marker = /(?:class|id)=["'][^"']*(?:jobdescription|job-description|job_description|jobcontent|job-content)[^"']*["']/i;
  const marked = markedElementHtml(source, marker);
  if (marked) return marked;

  const heading = /<h[1-6]\b[^>]*>\s*(?:<[^>]+>\s*)*(?:Job description|Stellenbeschreibung|Description du poste|Descripción del (?:puesto|trabajo))\s*(?:<[^>]+>\s*)*<\/h[1-6]>/i.exec(source);
  if (!heading) return '';
  const start = heading.index + heading[0].length;
  const remainder = source.slice(start, Math.min(source.length, start + MAX_DETAIL_BYTES));
  const stops = [
    /<footer\b/i,
    /<h[1-6]\b[^>]*>[^<]*(?:Similar Jobs|Share this Job|Apply now)[^<]*<\/h[1-6]>/i,
    /<(?:div|section)\b[^>]*(?:class|id)=["'][^"']*(?:similar-jobs|apply|job-alert)[^"']*["']/i,
  ];
  let end = remainder.length;
  for (const stop of stops) {
    const hit = stop.exec(remainder);
    if (hit && hit.index < end) end = hit.index;
  }
  return remainder.slice(0, end);
}

function sameOriginApplyUrl(html, endpoint) {
  const source = String(html ?? '');
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(source)) !== null) {
    const label = htmlToPlainText(match[2]).toLowerCase();
    if (!/^apply(?: now)?(?: »)?$/.test(label)) continue;
    const href = match[1].match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      const parsed = new URL(href, endpoint);
      if (parsed.protocol === 'https:' && parsed.origin === endpoint.origin) {
        return parsed.href;
      }
    } catch {
      /* Ignore malformed apply links. */
    }
  }
  return null;
}

export function parseSuccessFactorsHtmlDetails(html, pageUrl) {
  const endpoint = pageUrl instanceof URL ? pageUrl : new URL(pageUrl);
  const description = htmlToPlainText(successFactorsDescriptionHtml(html));
  if (!description) return null;
  const plain = htmlToPlainText(html);
  const location = plain.match(/(?:^|\n)Location:\s*([^\n]+)(?:\n|$)/i)?.[1]?.trim() ?? '';
  return {
    description,
    applyUrl: sameOriginApplyUrl(html, endpoint) || endpoint.href,
    locations: [],
    remoteType: /\bremote\b/i.test(location) ? 'Remote' : null,
  };
}

function assertJsonLdSource(candidate) {
  const endpoint = assertPublicHttpsUrl(candidate.url, `${candidate.sourceProvider} detail URL`);
  if (candidate.sourceProvider === 'softgarden') {
    if (!SOFTGARDEN_HOST_RE.test(endpoint.hostname)) {
      throw new Error(`Unexpected Softgarden detail host: ${endpoint.hostname}`);
    }
    return endpoint;
  }
  if (candidate.sourceProvider === 'successfactors') {
    const sourceOrigin = candidate.provenance?.sourceOrigin;
    if (!sourceOrigin || !sameOrigin(endpoint, sourceOrigin)) {
      throw new Error('SuccessFactors detail URL must match the configured source origin');
    }
    return endpoint;
  }
  throw new Error(`Unsupported JSON-LD source provider: ${candidate.sourceProvider}`);
}

async function fetchJsonLdDetails(candidate, context) {
  const endpoint = assertJsonLdSource(candidate);
  const html = await fetchTextWithTimeout({
    fetchImpl: context.fetchImpl,
    url: endpoint,
    timeoutMs: context.timeoutMs,
  });
  const parsed = parseJobPostingJsonLd(html, endpoint.href);
  if (!parsed) throw new Error('Detail page contains no parseable JobPosting JSON-LD');
  return {
    ...parsed,
    descriptionStatus: `${candidate.sourceProvider}-jobposting-jsonld`,
  };
}


function successFactorsSourceOrigin(candidate) {
  const raw = candidate.provenance?.sourceOrigin;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('SuccessFactors detail fetch requires source origin');
  }
  return assertPublicHttpsUrl(raw, 'SuccessFactors source origin').origin;
}

function successFactorsDetailSession(candidate, context) {
  const origin = successFactorsSourceOrigin(candidate);
  let pending = context.successFactorsDetailSessions.get(origin);
  if (pending) return pending;

  pending = (async () => {
    const session = createHttpSession({
      fetchImpl: context.fetchImpl,
      timeoutMs: context.timeoutMs,
      userAgent: BROWSER_LIKE_USER_AGENT,
      maxResponseBytes: MAX_DETAIL_BYTES,
    });
    try {
      await session.fetchText(`${origin}/`, {
        redirect: 'follow',
        headers: {
          accept: 'text/html,application/xhtml+xml',
          referer: `${origin}/search/`,
        },
      });
    } catch {
      /* Bootstrap is best-effort; the detail request remains authoritative. */
    }
    return session;
  })();

  context.successFactorsDetailSessions.set(origin, pending);
  pending.catch(() => {
    if (context.successFactorsDetailSessions.get(origin) === pending) {
      context.successFactorsDetailSessions.delete(origin);
    }
  });
  return pending;
}

async function fetchSuccessFactorsDetailHtml(candidate, endpoint, context) {
  const origin = successFactorsSourceOrigin(candidate);
  const request = async () => {
    const session = await successFactorsDetailSession(candidate, context);
    return session.fetchText(endpoint, {
      redirect: 'follow',
      headers: {
        accept: 'text/html,application/xhtml+xml',
        referer: `${origin}/search/`,
      },
    });
  };

  try {
    return await request();
  } catch (error) {
    if (![401, 403].includes(error?.status)) throw error;
    context.successFactorsDetailSessions.delete(origin);
    return request();
  }
}

async function fetchSuccessFactorsDetails(candidate, context) {
  const endpoint = assertJsonLdSource(candidate);
  const html = await fetchSuccessFactorsDetailHtml(candidate, endpoint, context);
  const jsonLd = parseJobPostingJsonLd(html, endpoint.href);
  if (jsonLd) {
    return {
      ...jsonLd,
      descriptionStatus: 'successfactors-jobposting-jsonld',
    };
  }
  const page = parseSuccessFactorsHtmlDetails(html, endpoint);
  if (!page) {
    if (/You can(?:'|’)t view this job because it(?:'|’)s not available at this time\./i.test(html)) {
      throw new Error('SuccessFactors detail page reports that the job is unavailable');
    }
    throw new Error('Detail page contains neither JobPosting JSON-LD nor a parseable SuccessFactors job description');
  }
  return {
    ...page,
    descriptionStatus: 'successfactors-html-detail',
  };
}

async function fetchDetails(candidate, context) {
  const provider = candidate.sourceProvider
    || candidate.canonicalIdentity?.provider
    || null;
  switch (provider) {
    case 'greenhouse':
      return { supported: true, ...(await fetchGreenhouseDetails(candidate, context)) };
    case 'ashby':
      return { supported: true, ...(await fetchAshbyDetails(candidate, context)) };
    case 'smartrecruiters':
      return { supported: true, ...(await fetchSmartRecruitersDetails(candidate, context)) };
    case 'softgarden':
      return { supported: true, ...(await fetchJsonLdDetails(candidate, context)) };
    case 'successfactors':
      return { supported: true, ...(await fetchSuccessFactorsDetails(candidate, context)) };
    case 'personio':
      return { supported: false, provider, reason: 'description_available_in_list_feed' };
    default:
      return { supported: false, provider };
  }
}

export async function enrichCandidateDetails(
  candidates,
  {
    concurrency,
    maxFetches,
    timeoutMs,
    fetchImpl = fetch,
    onProgress = null,
  },
) {
  const context = {
    fetchImpl,
    timeoutMs,
    ashbyBoardCache: new Map(),
    successFactorsDetailSessions: new Map(),
  };
  const eligibleIndices = [];
  const output = candidates.map((candidate, index) => {
    if (candidate.preflight?.status !== 'ok') {
      return { ...candidate, detail: { status: 'skipped_preflight_error' } };
    }
    if (candidate.preflight.exists) {
      return { ...candidate, detail: { status: 'skipped_existing' } };
    }
    if (typeof candidate.description === 'string' && candidate.description.trim() !== '') {
      return {
        ...candidate,
        detail: {
          status: 'already_present',
          provider: candidate.sourceProvider ?? null,
          descriptionStatus: candidate.descriptionStatus,
        },
      };
    }
    eligibleIndices.push(index);
    return candidate;
  });

  const selectedIndices = eligibleIndices.slice(0, maxFetches);
  for (const index of eligibleIndices.slice(maxFetches)) {
    output[index] = { ...output[index], detail: { status: 'skipped_limit' } };
  }

  const fetched = await mapLimit(
    selectedIndices,
    concurrency,
    async (index) => {
      const candidate = output[index];
      const provider = candidate.sourceProvider
        || candidate.canonicalIdentity?.provider
        || null;
      try {
        const details = await fetchDetails(candidate, context);
        if (!details.supported) {
          return {
            index,
            candidate: {
              ...candidate,
              detail: {
                status: 'unsupported_provider',
                provider,
                reason: details.reason ?? null,
              },
            },
          };
        }
        const description = typeof details.description === 'string'
          ? details.description.trim()
          : '';
        const fetchedRawLocation = typeof details.rawLocation === 'string'
          ? details.rawLocation.trim()
          : '';
        const existingRawLocation = typeof candidate.rawLocation === 'string'
          ? candidate.rawLocation.trim()
          : '';
        const detailRawLocation = fetchedRawLocation
          && fetchedRawLocation.localeCompare(existingRawLocation, undefined, {
            sensitivity: 'accent',
          }) !== 0
          ? fetchedRawLocation
          : candidate.detailRawLocation || null;
        return {
          index,
          candidate: {
            ...candidate,
            applyUrl: safeApplyUrl(details.applyUrl) || candidate.applyUrl || candidate.url,
            description,
            descriptionStatus: description ? details.descriptionStatus : 'missing',
            detailRawLocation,
            locations: Array.isArray(details.locations) && details.locations.length > 0
              ? details.locations
              : candidate.locations,
            remoteType: details.remoteType || candidate.remoteType,
            detail: {
              status: description ? 'ok' : 'missing_description',
              provider,
              descriptionStatus: description ? details.descriptionStatus : 'missing',
            },
          },
        };
      } catch (error) {
        return {
          index,
          candidate: {
            ...candidate,
            detail: {
              status: 'error',
              provider,
              error: error instanceof Error ? error.message : String(error),
            },
          },
        };
      }
    },
    onProgress,
  );

  for (const item of fetched) output[item.index] = item.candidate;
  return output;
}
