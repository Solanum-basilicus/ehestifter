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

function normalizeLocations(locations) {
  if (!Array.isArray(locations)) {
    return [];
  }

  const output = [];
  const seen = new Set();

  for (const location of locations) {
    if (!location || typeof location !== 'object') {
      throw new Error('Each location must be an object');
    }

    const countryName = requiredString(
      location.countryName,
      'location.countryName',
    );

    const cityName = optionalString(location.cityName);
    const region = optionalString(location.region);

    let countryCode = optionalString(location.countryCode);

    if (countryCode !== null) {
      countryCode = countryCode.toUpperCase();

      if (!/^[A-Z]{2}$/.test(countryCode)) {
        throw new Error(
          `Invalid countryCode for ${countryName}: ${countryCode}`,
        );
      }
    }

    const key = [
      countryName.toLocaleLowerCase('en'),
      cityName?.toLocaleLowerCase('en') ?? '',
    ].join('\u0000');

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    output.push({
      countryName,
      countryCode,
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
  } = {},
) {
  const identity = candidate.canonicalIdentity;

  if (!identity || typeof identity !== 'object') {
    throw new Error('Candidate has no canonical identity');
  }

  const description = plainTextToSafeHtml(
    candidate.description,
  );

  if (requireDescription && description === '') {
    throw new Error('Candidate has no description');
  }

  return {
    url: requiredString(candidate.url, 'candidate.url'),

    applyUrl:
      optionalString(candidate.applyUrl)
      ?? requiredString(candidate.url, 'candidate.url'),

    foundOn: requiredString(
      candidate.foundOn,
      'candidate.foundOn',
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
      ?? optionalString(
        candidate.urlInference?.postingCompanyName,
      ),

    title: requiredString(
      candidate.title,
      'candidate.title',
    ),

    remoteType:
      optionalString(candidate.remoteType)
      ?? 'Unknown',

    description,

    locations: normalizeLocations(candidate.locations),
  };
}
