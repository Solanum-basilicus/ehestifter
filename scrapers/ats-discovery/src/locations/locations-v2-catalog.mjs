import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { lookupKey } from './geo-dictionary.mjs';

const DEFAULT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'data',
  'locations-v2.generated.json.gz',
);

const EU_COUNTRY_CODES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
];
const EEA_COUNTRY_CODES = [...EU_COUNTRY_CODES, 'IS', 'LI', 'NO'];
const countryClaims = (codes) => codes.map((code) => ['country', `iso3166:${code}`]);

const BROAD_SCOPE_ALIASES = new Map([
  ['world', [['globalRegion', 'm49:001']]],
  ['worldwide', [['globalRegion', 'm49:001']]],
  ['global', [['globalRegion', 'm49:001']]],
  ['globally', [['globalRegion', 'm49:001']]],
  ['europe', [['globalRegion', 'm49:150']]],
  ['eu', countryClaims(EU_COUNTRY_CODES)],
  ['european union', countryClaims(EU_COUNTRY_CODES)],
  ['eea', countryClaims(EEA_COUNTRY_CODES)],
  ['european economic area', countryClaims(EEA_COUNTRY_CODES)],
  ['north america', [['globalRegion', 'm49:021']]],
  ['africa', [['globalRegion', 'm49:002']]],
  ['americas', [['globalRegion', 'm49:019']]],
  ['latin america', [['globalRegion', 'm49:419']]],
  ['latam', [['globalRegion', 'm49:419']]],
  ['dach', [
    ['country', 'iso3166:DE'],
    ['country', 'iso3166:AT'],
    ['country', 'iso3166:CH'],
  ]],
  ['emea', [
    ['globalRegion', 'm49:150'],
    ['globalRegion', 'm49:002'],
    ['globalRegion', 'm49:145'],
  ]],
]);

function cleanText(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

function keyFor(kind, id) {
  return `${kind}\u0000${id}`;
}

function pushIndex(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function aliases(item) {
  return [item.name, ...(Array.isArray(item.aliases) ? item.aliases : [])];
}

function cityLookupTerms(item) {
  const terms = new Set(aliases(item).filter(Boolean));
  for (const value of [...terms]) {
    const withoutParenthetical = value.replace(/\s*\([^)]{1,40}\)\s*$/u, '').trim();
    if (withoutParenthetical.length >= 4 && withoutParenthetical !== value) {
      terms.add(withoutParenthetical);
    }
    const connector = value.match(/^(.{4,60}?)\s+(?:am|an\s+der|an\s+den|upon|on)\s+.{2,60}$/iu);
    if (connector) terms.add(connector[1].trim());
  }
  return [...terms];
}

function uniqueById(items) {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function editDistance(left, right, maximum) {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > maximum) return maximum + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    let rowMinimum = row;
    for (let column = 1; column <= right.length; column += 1) {
      const value = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > maximum) return maximum + 1;
    previous = current;
  }
  return previous[right.length];
}

function dominantCity(items) {
  const unique = uniqueById(items);
  if (unique.length <= 1) return unique[0] ?? null;
  const ranked = [...unique].sort((left, right) => (
    Number(right.population ?? 0) - Number(left.population ?? 0)
    || left.id.localeCompare(right.id)
  ));
  const first = Number(ranked[0].population ?? 0);
  const second = Number(ranked[1].population ?? 0);
  if (first >= 50_000 && first >= 2 * second && first - second >= 50_000) {
    return ranked[0];
  }
  return null;
}

function exactPhraseRegex(value) {
  const tokens = lookupKey(value).split(' ').filter(Boolean);
  if (tokens.length === 0) return null;
  const body = tokens
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('[^\\p{L}\\p{N}]+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu');
}

export function createLocationsV2Catalog(data) {
  if (!data || data.schemaVersion !== 1) {
    throw new Error('Locations v2 parser snapshot schemaVersion must be 1');
  }
  const all = [
    ...(data.regions ?? []),
    ...(data.countries ?? []),
    ...(data.adminRegions ?? []),
    ...(data.cities ?? []),
  ];
  const byIdentity = new Map(all.map((item) => [keyFor(item.kind, item.id), item]));
  const byId = new Map(all.map((item) => [item.id, item]));
  const countryByCode = new Map((data.countries ?? []).map((item) => [item.countryCode, item]));
  const countryByName = new Map();
  const adminByCountryName = new Map();
  const adminByName = new Map();
  const cityByCountryName = new Map();
  const cityByName = new Map();
  const globalCityNameKeys = new Set();

  for (const item of data.countries ?? []) {
    for (const alias of aliases(item)) countryByName.set(lookupKey(alias), item);
    countryByName.set(lookupKey(item.countryCode), item);
  }
  const countryAliases = new Map([
    ['deutschland', 'DE'], ['germany', 'DE'], ['usa', 'US'], ['u s a', 'US'],
    ['us', 'US'], ['u s', 'US'], ['united states of america', 'US'],
    ['uk', 'GB'], ['u k', 'GB'], ['great britain', 'GB'], ['britain', 'GB'],
    ['uae', 'AE'], ['u a e', 'AE'], ['czech republic', 'CZ'],
    ['south korea', 'KR'], ['republic of korea', 'KR'], ['viet nam', 'VN'],
  ]);
  for (const [name, code] of countryAliases) {
    const country = countryByCode.get(code);
    if (country) countryByName.set(name, country);
  }

  for (const item of data.adminRegions ?? []) {
    const terms = [...aliases(item), item.admin1Code].filter(Boolean);
    for (const term of terms) {
      const key = lookupKey(term);
      pushIndex(adminByCountryName, `${item.countryCode}\u0000${key}`, item);
      pushIndex(adminByName, key, item);
    }
  }
  for (const item of data.cities ?? []) {
    for (const term of cityLookupTerms(item)) {
      const termKey = lookupKey(term);
      pushIndex(cityByCountryName, `${item.countryCode}\u0000${termKey}`, item);
      pushIndex(cityByName, termKey, item);
      globalCityNameKeys.add(termKey);
    }
  }

  function get(kind, id) {
    return byIdentity.get(keyFor(kind, id)) ?? null;
  }

  function getById(id) {
    return byId.get(id) ?? null;
  }

  function resolveCountry(value) {
    return countryByName.get(lookupKey(value)) ?? null;
  }

  function resolveCountryApproximate(value) {
    const key = lookupKey(value);
    if (key.length < 5 || !/^[\p{L} ]+$/u.test(key)) return null;
    const exact = countryByName.get(key);
    if (exact) return exact;
    const maximum = key.length >= 6 ? 2 : 1;
    const matches = [];
    for (const [candidateKey, country] of countryByName) {
      if (candidateKey.length < 5 || !/^[\p{L} ]+$/u.test(candidateKey)) continue;
      const distance = editDistance(key, candidateKey, maximum);
      if (distance <= maximum) matches.push({ country, distance });
    }
    if (matches.length === 0) return null;
    matches.sort((left, right) => left.distance - right.distance || left.country.countryCode.localeCompare(right.country.countryCode));
    const bestDistance = matches[0].distance;
    const best = uniqueById(matches.filter((item) => item.distance === bestDistance).map((item) => item.country));
    if (best.length !== 1) return null;
    const secondDistance = matches.find((item) => item.country.id !== best[0].id)?.distance ?? Number.POSITIVE_INFINITY;
    if (secondDistance <= bestDistance + 1) return null;
    return best[0];
  }

  function resolveAdminRegion(value, { countryCode = null, allowAmbiguous = false } = {}) {
    const key = lookupKey(value);
    if (!key) return null;
    const items = countryCode
      ? adminByCountryName.get(`${cleanText(countryCode).toUpperCase()}\u0000${key}`) ?? []
      : adminByName.get(key) ?? [];
    const unique = uniqueById(items);
    if (!countryCode && !allowAmbiguous && globalCityNameKeys.has(key)) return null;
    if (unique.length === 1) return unique[0];
    if (allowAmbiguous && unique.length > 0) {
      return [...unique].sort((left, right) => left.id.localeCompare(right.id))[0];
    }
    return null;
  }

  function findAdminRegionMentions(value, { countryCode = null } = {}) {
    const text = cleanText(value);
    if (!text) return [];
    const source = countryCode
      ? (data.adminRegions ?? []).filter((item) => item.countryCode === countryCode)
      : (data.adminRegions ?? []);
    const found = [];
    for (const item of source) {
      for (const term of aliases(item)) {
        if (term.length < 4) continue;
        if (!countryCode && globalCityNameKeys.has(lookupKey(term))) continue;
        const pattern = exactPhraseRegex(term);
        if (pattern?.test(text)) {
          found.push(item);
          break;
        }
      }
    }
    return uniqueById(found);
  }

  function resolveCity(value, countryCode, { adminRegion = null } = {}) {
    const code = cleanText(countryCode).toUpperCase();
    const candidates = uniqueById(
      cityByCountryName.get(`${code}\u0000${lookupKey(value)}`) ?? [],
    );
    const adminId = typeof adminRegion === 'string'
      ? resolveAdminRegion(adminRegion, { countryCode: code })?.id ?? adminRegion
      : adminRegion?.id ?? null;
    const filtered = adminId
      ? candidates.filter((item) => item.admin1Id === adminId)
      : candidates;
    if (filtered.length === 1) return filtered[0];
    return dominantCity(filtered);
  }

  function resolveCityGlobal(value) {
    const candidates = uniqueById(cityByName.get(lookupKey(value)) ?? []);
    return dominantCity(candidates);
  }

  function facts(item) {
    if (!item) return [];
    return [item, ...(item.ancestors ?? []).map(getById).filter(Boolean)];
  }

  function selectorValid(selector) {
    if (!selector || typeof selector !== 'object' || Array.isArray(selector)) return null;
    return get(selector.kind, selector.locationId);
  }

  function canonicalFromLegacy(location) {
    if (!location || typeof location !== 'object') return null;
    const country = resolveCountry(location.countryCode)
      ?? resolveCountry(location.countryName)
      ?? (!cleanText(location.cityName) && !cleanText(location.region)
        ? resolveCountryApproximate(location.countryName)
        : null);
    if (!country) return null;
    const regionText = cleanText(location.region);
    const adminRegion = regionText
      ? resolveAdminRegion(regionText, { countryCode: country.countryCode })
      : null;
    if (cleanText(location.cityName)) {
      const city = resolveCity(location.cityName, country.countryCode, { adminRegion });
      if (city) return city;
      return null;
    }
    if (regionText) return adminRegion;
    return country;
  }

  function broadScopeClaims(value) {
    const text = cleanText(value);
    if (!text) return [];
    const normalized = lookupKey(text);
    if (/\b(?:except|excluding|exclude|not available in|not hiring in)\b/u.test(normalized)) {
      return [];
    }
    const claims = [];
    for (const [term, identities] of BROAD_SCOPE_ALIASES) {
      const pattern = exactPhraseRegex(term);
      if (!pattern?.test(text)) continue;
      for (const [kind, id] of identities) {
        const item = get(kind, id);
        if (item) claims.push(item);
      }
    }
    return uniqueById(claims);
  }

  return Object.freeze({
    schemaVersion: data.schemaVersion,
    sourceSchemaVersion: data.sourceSchemaVersion,
    catalogVersion: data.catalogVersion,
    referenceYear: data.referenceYear,
    get,
    getById,
    resolveCountry,
    resolveCountryApproximate,
    resolveAdminRegion,
    findAdminRegionMentions,
    resolveCity,
    resolveCityGlobal,
    facts,
    selectorValid,
    canonicalFromLegacy,
    broadScopeClaims,
  });
}

let defaultCatalog = null;

export function loadLocationsV2Catalog(snapshotPath = DEFAULT_PATH) {
  const data = JSON.parse(gunzipSync(readFileSync(snapshotPath)).toString('utf8'));
  return createLocationsV2Catalog(data);
}

export function getDefaultLocationsV2Catalog() {
  if (!defaultCatalog) defaultCatalog = loadLocationsV2Catalog();
  return defaultCatalog;
}
