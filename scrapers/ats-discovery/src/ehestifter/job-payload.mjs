import { getDefaultGeoDictionary } from '../locations/geo-dictionary.mjs';
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

export function buildCreatePayload(
  candidate,
  {
    requireDescription = true,
    dictionary = getDefaultGeoDictionary(),
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
  };
}
