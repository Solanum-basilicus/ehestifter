import { htmlToPlainText } from '../text/html.mjs';

const MAX_JSON_LD_SCRIPTS = 100;
const MAX_JSON_LD_BYTES = 2_000_000;
const MAX_TRAVERSAL_NODES = 10_000;

function typeIncludesJobPosting(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.some(
    (item) => String(item ?? '').toLowerCase() === 'jobposting',
  );
}

function findJobPosting(value) {
  const queue = [value];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_TRAVERSAL_NODES) {
    const current = queue.shift();
    visited += 1;
    if (!current || typeof current !== 'object') continue;
    if (typeIncludesJobPosting(current['@type'])) return current;
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (Array.isArray(current['@graph'])) queue.push(...current['@graph']);
    for (const nested of Object.values(current)) {
      if (nested && typeof nested === 'object' && nested !== current['@graph']) {
        queue.push(nested);
      }
    }
  }
  return null;
}

function stringValue(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    for (const key of ['name', 'value', '@value']) {
      if (typeof value[key] === 'string' && value[key].trim()) {
        return value[key].trim();
      }
    }
  }
  return '';
}

function locationFromAddress(address) {
  if (!address || typeof address !== 'object') return null;
  const isCountry = String(address['@type'] ?? '').toLowerCase() === 'country';
  const countryName = stringValue(address.addressCountry)
    || (isCountry ? stringValue(address.name) : '');
  if (!countryName) return null;
  return {
    countryName,
    countryCode: null,
    cityName: stringValue(address.addressLocality) || null,
    region: stringValue(address.addressRegion) || null,
  };
}

function collectLocations(jobPosting) {
  const locations = [];
  const seen = new Set();
  function add(location) {
    if (!location?.countryName) return;
    const key = [
      location.countryName,
      location.cityName ?? '',
      location.region ?? '',
    ].map((value) => value.toLowerCase()).join('\0');
    if (seen.has(key)) return;
    seen.add(key);
    locations.push(location);
  }

  const jobLocations = Array.isArray(jobPosting.jobLocation)
    ? jobPosting.jobLocation
    : jobPosting.jobLocation == null
      ? []
      : [jobPosting.jobLocation];
  for (const location of jobLocations) {
    add(locationFromAddress(location?.address ?? location));
  }

  const applicantLocations = Array.isArray(jobPosting.applicantLocationRequirements)
    ? jobPosting.applicantLocationRequirements
    : jobPosting.applicantLocationRequirements == null
      ? []
      : [jobPosting.applicantLocationRequirements];
  for (const location of applicantLocations) {
    add(locationFromAddress(location?.address ?? location));
  }
  return locations;
}

function remoteType(jobPosting) {
  const value = Array.isArray(jobPosting.jobLocationType)
    ? jobPosting.jobLocationType.join(' ')
    : String(jobPosting.jobLocationType ?? '');
  return /telecommute|remote/i.test(value) ? 'Remote' : null;
}

function safeApplyUrl(value, sourceUrl) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const resolved = new URL(value, sourceUrl);
    return resolved.protocol === 'https:'
      && resolved.origin === new URL(sourceUrl).origin
      ? resolved.href
      : null;
  } catch {
    return null;
  }
}

export function parseJobPostingJsonLd(html, sourceUrl) {
  if (typeof html !== 'string' || html === '') return null;
  const scriptRe = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let count = 0;
  while ((match = scriptRe.exec(html)) !== null && count < MAX_JSON_LD_SCRIPTS) {
    count += 1;
    if (Buffer.byteLength(match[1], 'utf8') > MAX_JSON_LD_BYTES) continue;
    let parsed;
    try {
      parsed = JSON.parse(match[1].trim());
    } catch {
      continue;
    }
    const jobPosting = findJobPosting(parsed);
    if (!jobPosting) continue;
    const description = htmlToPlainText(jobPosting.description);
    return {
      description,
      locations: collectLocations(jobPosting),
      remoteType: remoteType(jobPosting),
      applyUrl: safeApplyUrl(jobPosting.url, sourceUrl),
    };
  }
  return null;
}
