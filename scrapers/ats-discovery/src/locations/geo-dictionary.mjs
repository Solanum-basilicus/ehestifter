import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SNAPSHOT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'data',
  'web-geo.generated.json',
);

const COUNTRY_ALIASES = new Map([
  ['deutschland', 'DE'],
  ['german federal republic', 'DE'],
  ['us', 'US'],
  ['u s', 'US'],
  ['usa', 'US'],
  ['u s a', 'US'],
  ['united states of america', 'US'],
  ['uk', 'GB'],
  ['u k', 'GB'],
  ['great britain', 'GB'],
  ['britain', 'GB'],
  ['bosnia', 'BA'],
  ['bosnia herzegovina', 'BA'],
  ['uae', 'AE'],
  ['u a e', 'AE'],
  ['czech republic', 'CZ'],
  ['republic of korea', 'KR'],
  ['korea south', 'KR'],
  ['south korea', 'KR'],
  ['russian federation', 'RU'],
  ['ivory coast', 'CI'],
  ['cote d ivoire', 'CI'],
  ['viet nam', 'VN'],
]);

function cleanText(value) {
  return typeof value === 'string'
    ? value.replace(/\s+/gu, ' ').trim()
    : '';
}

function punctuationFold(value) {
  return cleanText(value)
    .replace(/[.·_]/gu, ' ')
    .replace(/[’‘`]/gu, "'")
    .replace(/[-–—]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function lookupKey(value) {
  return punctuationFold(value)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function germanTransliterationKey(value) {
  return punctuationFold(value)
    .replace(/Ä/gu, 'Ae')
    .replace(/Ö/gu, 'Oe')
    .replace(/Ü/gu, 'Ue')
    .replace(/ä/gu, 'ae')
    .replace(/ö/gu, 'oe')
    .replace(/ü/gu, 'ue')
    .replace(/ß/gu, 'ss')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function keysForName(value) {
  return new Set([
    lookupKey(value),
    germanTransliterationKey(value),
  ].filter(Boolean));
}

function validateGeoData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Geo snapshot must be an object');
  }
  if (!Array.isArray(data.countries)) {
    throw new Error('Geo snapshot countries must be an array');
  }
  if (!data.cities || typeof data.cities !== 'object' || Array.isArray(data.cities)) {
    throw new Error('Geo snapshot cities must be an object');
  }
}

export function createGeoDictionary(data) {
  validateGeoData(data);

  const countriesByCode = new Map();
  const countriesByKey = new Map();
  const citiesByCountry = new Map();
  const globalCities = new Map();
  const countryTextTerms = new Map();

  for (const item of data.countries) {
    const code = cleanText(item?.code).toUpperCase();
    const name = cleanText(item?.name);
    if (!/^[A-Z]{2}$/u.test(code) || name === '') {
      throw new Error(`Invalid geo country entry: ${JSON.stringify(item)}`);
    }
    if (countriesByCode.has(code)) {
      throw new Error(`Duplicate geo country code: ${code}`);
    }
    const country = Object.freeze({
      countryName: name,
      countryCode: code,
    });
    countriesByCode.set(code, country);
    for (const key of keysForName(name)) {
      countriesByKey.set(key, country);
      countryTextTerms.set(key, country);
    }
    countriesByKey.set(lookupKey(code), country);
  }

  for (const [alias, code] of COUNTRY_ALIASES) {
    const country = countriesByCode.get(code);
    if (country) {
      countriesByKey.set(alias, country);
      countryTextTerms.set(alias, country);
    }
  }

  for (const [rawCode, rawCities] of Object.entries(data.cities)) {
    const code = cleanText(rawCode).toUpperCase();
    if (!countriesByCode.has(code) || !Array.isArray(rawCities)) continue;
    const cityMap = new Map();
    for (const rawCity of rawCities) {
      const cityName = cleanText(rawCity);
      if (cityName === '') continue;
      for (const key of keysForName(cityName)) {
        if (!cityMap.has(key)) cityMap.set(key, cityName);
        if (!globalCities.has(key)) globalCities.set(key, new Map());
        globalCities.get(key).set(code, cityName);
      }
    }
    citiesByCountry.set(code, cityMap);
  }

  function resolveCountry(value) {
    const key = lookupKey(value);
    if (key === '') return null;
    return countriesByKey.get(key) ?? null;
  }

  function countryByCode(value) {
    const code = cleanText(value).toUpperCase();
    return countriesByCode.get(code) ?? null;
  }

  function resolveCity(value, countryCode = null) {
    const keys = keysForName(value);
    if (keys.size === 0) return null;

    if (countryCode) {
      const code = cleanText(countryCode).toUpperCase();
      const cityMap = citiesByCountry.get(code);
      if (!cityMap) return null;
      for (const key of keys) {
        const cityName = cityMap.get(key);
        if (cityName) {
          return { cityName, countryCode: code };
        }
      }
      return null;
    }

    const matches = new Map();
    for (const key of keys) {
      const candidates = globalCities.get(key);
      if (!candidates) continue;
      for (const [code, cityName] of candidates) {
        matches.set(code, cityName);
      }
    }
    if (matches.size !== 1) return null;
    const [[code, cityName]] = matches.entries();
    return { cityName, countryCode: code };
  }


  function findCountryMentions(value) {
    const key = lookupKey(value);
    if (key === '') return [];
    const padded = ` ${key} `;
    const found = new Map();
    for (const [term, country] of countryTextTerms) {
      if (!padded.includes(` ${term} `)) continue;
      if (!found.has(country.countryCode)) {
        found.set(country.countryCode, { ...country, matchedTerm: term });
      }
    }
    return [...found.values()];
  }

  function canonicalizeLocation(location) {
    if (!location || typeof location !== 'object' || Array.isArray(location)) {
      return {
        status: 'invalid_location',
        location: null,
        unresolved: ['location_not_object'],
      };
    }

    const rawCode = cleanText(location.countryCode).toUpperCase();
    const byCode = rawCode
      ? countryByCode(rawCode) ?? resolveCountry(rawCode)
      : null;
    const byName = resolveCountry(location.countryName);
    const country = byCode ?? byName;
    const unresolved = [];

    if (rawCode && !byCode) unresolved.push('country_code_unresolved');
    if (!country) {
      unresolved.push('country_unresolved');
      return { status: 'country_unresolved', location: null, unresolved };
    }
    if (byCode && byName && byCode.countryCode !== byName.countryCode) {
      unresolved.push('country_name_code_conflict');
      return { status: 'country_name_code_conflict', location: null, unresolved };
    }

    const rawCity = cleanText(location.cityName);
    let cityName = null;
    if (rawCity !== '') {
      const city = resolveCity(rawCity, country.countryCode);
      if (city) cityName = city.cityName;
      else unresolved.push('city_unresolved_for_country');
    }

    return {
      status: unresolved.length > 0 ? 'normalized_with_unresolved' : 'normalized',
      location: {
        ...country,
        cityName,
        region: cleanText(location.region) || null,
      },
      unresolved,
    };
  }

  return Object.freeze({
    countriesByCode,
    resolveCountry,
    countryByCode,
    resolveCity,
    findCountryMentions,
    canonicalizeLocation,
  });
}

let defaultDictionary = null;

export function loadGeoDictionary(snapshotPath = DEFAULT_SNAPSHOT_PATH) {
  const raw = readFileSync(snapshotPath, 'utf8');
  return createGeoDictionary(JSON.parse(raw));
}

export function getDefaultGeoDictionary() {
  if (!defaultDictionary) defaultDictionary = loadGeoDictionary();
  return defaultDictionary;
}
