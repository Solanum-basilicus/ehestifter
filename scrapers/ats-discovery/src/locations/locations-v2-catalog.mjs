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
  ['apac', [['globalRegion', 'm49:142'], ['globalRegion', 'm49:009']]],
  ['asia pacific', [['globalRegion', 'm49:142'], ['globalRegion', 'm49:009']]],
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

function dominantCityResolution(items) {
  const unique = uniqueById(items);
  if (unique.length === 0) return null;
  if (unique.length === 1) {
    const population = Number(unique[0].population ?? 0);
    return population >= 50_000
      ? { item: unique[0], method: 'exact_unique_city', confidence: 'high' }
      : null;
  }
  const ranked = [...unique].sort((left, right) => (
    Number(right.population ?? 0) - Number(left.population ?? 0)
    || left.id.localeCompare(right.id)
  ));
  const first = Number(ranked[0].population ?? 0);
  const second = Number(ranked[1].population ?? 0);
  if (first >= 50_000 && first >= 2 * second && first - second >= 50_000) {
    return { item: ranked[0], method: 'population_dominant_city', confidence: 'tentative' };
  }
  return null;
}

function unqualifiedDistrictAlias(value, city) {
  // A short alias for a district is not sufficient to select its location.
  // For example, Bade alone must not imply Bade District in Taiwan.
  const name = lookupKey(city.name);
  const stem = name.replace(/\s+district$/u, '');
  return stem !== name && lookupKey(value) === stem;
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
  const countryByAlpha3 = new Map((data.countries ?? [])
    .filter((item) => typeof item.alpha3Code === 'string' && item.alpha3Code.length === 3)
    .map((item) => [item.alpha3Code.toUpperCase(), item]));
  const countryByName = new Map();
  const adminByCountryName = new Map();
  const adminByName = new Map();
  const cityByCountryName = new Map();
  const cityByName = new Map();
  const canonicalByCountryName = new Map();
  const canonicalByName = new Map();
  const globalCityNameKeys = new Set();

  for (const item of data.countries ?? []) {
    for (const alias of aliases(item)) countryByName.set(lookupKey(alias), item);
    countryByName.set(lookupKey(item.countryCode), item);
    if (item.alpha3Code) countryByName.set(lookupKey(item.alpha3Code), item);
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
    pushIndex(canonicalByCountryName, `${item.countryCode}\u0000${lookupKey(item.name)}`, item);
    pushIndex(canonicalByName, lookupKey(item.name), item);
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

  function resolveCountryCode(value) {
    const code = cleanText(value).toUpperCase();
    return countryByCode.get(code) ?? countryByAlpha3.get(code) ?? null;
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
    const nameKey = `${code}\u0000${lookupKey(value)}`;
    const candidates = uniqueById(
      canonicalByCountryName.get(nameKey)?.length
        ? canonicalByCountryName.get(nameKey)
        : cityByCountryName.get(nameKey) ?? [],
    );
    const adminId = typeof adminRegion === 'string'
      ? resolveAdminRegion(adminRegion, { countryCode: code })?.id ?? adminRegion
      : adminRegion?.id ?? null;
    const filtered = adminId
      ? candidates.filter((item) => item.admin1Id === adminId)
      : candidates;
    if (filtered.length === 1) return filtered[0];
    return dominantCityResolution(filtered)?.item ?? null;
  }

  function resolveCityGlobalResolution(value) {
    const raw = cleanText(value);
    const key = lookupKey(raw);
    const canonical = canonicalByName.get(key) ?? [];
    const candidates = uniqueById(
      canonical.length ? canonical : cityByName.get(key) ?? [],
    ).filter((item) => canonical.length > 0 || !unqualifiedDistrictAlias(raw, item));
    if (!raw || /\d/u.test(raw)) return null;
    if (/^[A-Z]{3,6}$/u.test(raw)) return null;
    return dominantCityResolution(candidates);
  }

  function resolveCityGlobal(value) {
    return resolveCityGlobalResolution(value)?.item ?? null;
  }

  function resolveStandalone(value) {
    const raw = cleanText(value);
    const key = lookupKey(raw);
    if (!raw || !key || /\d/u.test(raw)) return null;
    const country = resolveCountry(raw);
    const admins = uniqueById(adminByName.get(key) ?? []);
    const canonical = canonicalByName.get(key) ?? [];
    const cities = uniqueById(
      canonical.length ? canonical : cityByName.get(key) ?? [],
    ).filter((item) => canonical.length > 0 || !unqualifiedDistrictAlias(raw, item));
    const codeLike = /^[A-Z]{2,6}$/u.test(raw);

    if (country) {
      if (admins.some((item) => item.countryCode !== country.countryCode)) return null;
      return { item: country, method: codeLike ? 'country_code' : 'exact_country', confidence: 'high' };
    }

    if (admins.length === 1) {
      const admin = admins[0];
      const nestedCities = cities.filter((item) => item.admin1Id === admin.id);
      if (nestedCities.length > 0) {
        const city = dominantCityResolution(nestedCities);
        if (city) return { ...city, method: 'exact_city_admin_hierarchy', confidence: 'high' };
      }
      if (!codeLike || raw.length === 2 || raw.length === 3) {
        return { item: admin, method: codeLike ? 'admin_code' : 'exact_admin_region', confidence: 'high' };
      }
    }

    if (codeLike) return null;
    return dominantCityResolution(cities);
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
    const country = resolveCountryCode(location.countryCode)
      ?? resolveCountry(location.countryName);
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
      // Treat business acronyms as scopes only when they are uppercase.
      if (['apac', 'emea', 'latam', 'dach'].includes(term)
        && !new RegExp(`\\b${term.toUpperCase()}\\b`, 'u').test(text)) continue;
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
    resolveCountryCode,
    resolveAdminRegion,
    findAdminRegionMentions,
    resolveCity,
    resolveCityGlobal,
    resolveCityGlobalResolution,
    resolveStandalone,
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
