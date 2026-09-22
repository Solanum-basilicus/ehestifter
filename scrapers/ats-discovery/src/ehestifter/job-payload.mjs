import { getDefaultGeoDictionary } from '../locations/geo-dictionary.mjs';
import { getDefaultLocationsV2Catalog } from '../locations/locations-v2-catalog.mjs';
import { plainTextToSafeHtml } from '../text/html.mjs';

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value.trim();
}

function optionalString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  return value.trim() || null;
}

function normalizeLocations(locations, dictionary = getDefaultGeoDictionary()) {
  if (!Array.isArray(locations)) {
    return [];
  }

  const output = [];
  const seen = new Set();
  for (const location of locations) {
    if (!location || typeof location !== 'object' || Array.isArray(location)) {
      throw new Error('Each location must be an object');
    }

    const suppliedName = requiredString(
      location.countryName,
      'location.countryName',
    );
    const rawCode = optionalString(location.countryCode);
    const suppliedCode = rawCode?.toUpperCase() ?? null;
    if (suppliedCode !== null && !/^[A-Z]{2}$/u.test(suppliedCode)) {
      throw new Error(`Invalid countryCode for ${suppliedName}: ${suppliedCode}`);
    }

    const countryByCode = suppliedCode
      ? dictionary.countryByCode(suppliedCode)
      : null;
    if (suppliedCode && !countryByCode) {
      throw new Error(`Unknown countryCode for ${suppliedName}: ${suppliedCode}`);
    }
    const countryByName = dictionary.resolveCountry(suppliedName);
    const country = countryByCode ?? countryByName;
    if (!country) throw new Error(`Unknown countryName: ${suppliedName}`);
    if (countryByCode && countryByName
      && countryByName.countryCode !== countryByCode.countryCode) {
      throw new Error(
        `countryName/countryCode mismatch: ${suppliedName}/${suppliedCode}`,
      );
    }
    const canonicalCode = country.countryCode;

    const suppliedCity = optionalString(location.cityName);
    let cityName = null;
    if (suppliedCity !== null) {
      const city = dictionary.resolveCity(suppliedCity, canonicalCode);
      if (!city) {
        throw new Error(`Unknown city for ${canonicalCode}: ${suppliedCity}`);
      }
      cityName = city.cityName;
    }
    const region = optionalString(location.region);
    const key = [
      canonicalCode,
      cityName?.toLocaleLowerCase('en') ?? '',
      region?.toLocaleLowerCase('en') ?? '',
    ].join('\u0000');

    if (seen.has(key)) continue;
    seen.add(key);
    output.push({
      countryName: country.countryName,
      countryCode: canonicalCode,
      cityName,
      region,
    });
  }

  return output;
}


function normalizeLocationsV2(locations, catalog = getDefaultLocationsV2Catalog()) {
  if (!Array.isArray(locations)) return [];
  const output = [];
  const seen = new Set();
  for (const location of locations) {
    if (!location || typeof location !== 'object' || Array.isArray(location)) {
      throw new Error('Each locationsV2 item must be an object');
    }
    const kind = location.kind;
    const locationId = optionalString(location.locationId);
    if (!locationId || !catalog.get(kind, locationId)) {
      throw new Error(`Invalid Locations v2 selector: ${kind ?? 'unknown'}:${locationId ?? ''}`);
    }
    const key = `${kind}\u0000${locationId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ kind, locationId });
  }
  return output;
}

function normalizeWorkTimeConstraintsV2(value) {
  if (!Array.isArray(value)) return [];
  const output = [];
  const seen = new Set();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Each workTimeConstraintsV2 item must be an object');
    }
    const start = item.offsetRangeStartMinutes;
    const end = item.offsetRangeEndMinutes;
    if (!Number.isInteger(start) || !Number.isInteger(end)
      || start < -840 || start > 840 || end < -840 || end > 840 || start > end) {
      throw new Error('Invalid workTimeConstraintsV2 offset range');
    }
    const key = `${start}:${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ offsetRangeStartMinutes: start, offsetRangeEndMinutes: end });
  }
  return output;
}

export function buildCreatePayload(
  candidate,
  {
    requireDescription = true,
    dictionary = getDefaultGeoDictionary(),
    v2Catalog = getDefaultLocationsV2Catalog(),
  } = {},
) {
  const identity = candidate.canonicalIdentity;

  if (!identity || typeof identity !== 'object') {
    throw new Error('Candidate has no canonical identity');
  }

  const description = plainTextToSafeHtml(candidate.description);

  if (requireDescription && description === '') {
    throw new Error('Candidate has no description');
  }
  return {
    url: requiredString(candidate.url, 'candidate.url'),

    applyUrl:
      optionalString(candidate.applyUrl)
      ?? requiredString(candidate.url, 'candidate.url'),

    foundOn: requiredString(candidate.foundOn, 'candidate.foundOn'),

    atsVendor: requiredString(
      candidate.sourceProvider,
      'candidate.sourceProvider',
    ),

    provider: requiredString(
      identity.provider,
      'canonicalIdentity.provider',
    ),

    providerTenant:
      typeof identity.providerTenant === 'string'
        ? identity.providerTenant.trim()
        : '',
    externalId: requiredString(
      identity.externalId,
      'canonicalIdentity.externalId',
    ),

    hiringCompanyName: requiredString(
      candidate.hiringCompanyName
      ?? candidate.sourceCompany
      ?? candidate.urlInference?.hiringCompanyName,
      'candidate.hiringCompanyName',
    ),

    postingCompanyName:
      optionalString(candidate.postingCompanyName)
      ?? optionalString(candidate.urlInference?.postingCompanyName),
    title: requiredString(candidate.title, 'candidate.title'),

    remoteType: optionalString(candidate.remoteType) ?? 'Unknown',

    description,

    locations: normalizeLocations(candidate.locations, dictionary),
    locationsV2: normalizeLocationsV2(candidate.locationsV2, v2Catalog),
    workTimeConstraintsV2: normalizeWorkTimeConstraintsV2(candidate.workTimeConstraintsV2),
  };
}
