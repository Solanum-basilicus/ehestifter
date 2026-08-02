import { lookupKey } from './geo-dictionary.mjs';

const US_REGIONS = [
  ['Alabama', 'AL'], ['Alaska', 'AK'], ['Arizona', 'AZ'], ['Arkansas', 'AR'],
  ['California', 'CA'], ['Colorado', 'CO'], ['Connecticut', 'CT'], ['Delaware', 'DE'],
  ['District of Columbia', 'DC', ['Washington DC', 'Washington, DC']],
  ['Florida', 'FL'], ['Georgia', 'GA'], ['Hawaii', 'HI'], ['Idaho', 'ID'],
  ['Illinois', 'IL'], ['Indiana', 'IN'], ['Iowa', 'IA'], ['Kansas', 'KS'],
  ['Kentucky', 'KY'], ['Louisiana', 'LA'], ['Maine', 'ME'], ['Maryland', 'MD'],
  ['Massachusetts', 'MA'], ['Michigan', 'MI'], ['Minnesota', 'MN'],
  ['Mississippi', 'MS'], ['Missouri', 'MO'], ['Montana', 'MT'], ['Nebraska', 'NE'],
  ['Nevada', 'NV'], ['New Hampshire', 'NH'], ['New Jersey', 'NJ'],
  ['New Mexico', 'NM'], ['New York', 'NY'], ['North Carolina', 'NC'],
  ['North Dakota', 'ND'], ['Ohio', 'OH'], ['Oklahoma', 'OK'], ['Oregon', 'OR'],
  ['Pennsylvania', 'PA'], ['Rhode Island', 'RI'], ['South Carolina', 'SC'],
  ['South Dakota', 'SD'], ['Tennessee', 'TN'], ['Texas', 'TX'], ['Utah', 'UT'],
  ['Vermont', 'VT'], ['Virginia', 'VA'], ['Washington', 'WA', ['Washington State']],
  ['West Virginia', 'WV'], ['Wisconsin', 'WI'], ['Wyoming', 'WY'],
];

const DE_REGIONS = [
  ['Baden-Württemberg', ['Baden Wuerttemberg']],
  ['Bavaria', ['Bayern']],
  ['Berlin'],
  ['Brandenburg'],
  ['Bremen'],
  ['Hamburg'],
  ['Hesse', ['Hessen']],
  ['Lower Saxony', ['Niedersachsen']],
  ['Mecklenburg-Vorpommern', ['Mecklenburg Western Pomerania']],
  ['North Rhine-Westphalia', ['Nordrhein-Westfalen', 'NRW']],
  ['Rhineland-Palatinate', ['Rheinland-Pfalz']],
  ['Saarland'],
  ['Saxony', ['Sachsen']],
  ['Saxony-Anhalt', ['Sachsen-Anhalt']],
  ['Schleswig-Holstein'],
  ['Thuringia', ['Thüringen', 'Thueringen']],
];

const AMBIGUOUS_WITHOUT_COUNTRY = new Set([
  'georgia',
  'washington',
  'berlin',
  'bremen',
  'hamburg',
]);

function cleanText(value) {
  return typeof value === 'string'
    ? value.replace(/\s+/gu, ' ').trim()
    : '';
}

function regionEntry(countryCode, regionName, aliases = []) {
  return Object.freeze({
    countryCode,
    regionName,
    aliases: Object.freeze([regionName, ...aliases]),
  });
}

const ENTRIES = Object.freeze([
  ...US_REGIONS.map(([name, abbreviation, aliases = []]) => (
    regionEntry('US', name, [abbreviation, ...aliases])
  )),
  ...DE_REGIONS.map(([name, aliases = []]) => regionEntry('DE', name, aliases)),
]);

const BY_KEY = new Map();
for (const entry of ENTRIES) {
  for (const alias of entry.aliases) {
    const key = lookupKey(alias);
    if (!BY_KEY.has(key)) BY_KEY.set(key, []);
    BY_KEY.get(key).push(entry);
  }
}

function uniqueEntry(entries) {
  const byIdentity = new Map(
    entries.map((entry) => [`${entry.countryCode}\u0000${entry.regionName}`, entry]),
  );
  return byIdentity.size === 1 ? [...byIdentity.values()][0] : null;
}

function exactRegion(value, countryCode, { allowAmbiguous = false } = {}) {
  const key = lookupKey(value);
  if (key === '') return null;
  const candidates = (BY_KEY.get(key) ?? []).filter((entry) => (
    !countryCode || entry.countryCode === countryCode
  ));
  const result = uniqueEntry(candidates);
  if (!result) return null;
  if (!countryCode && !allowAmbiguous && AMBIGUOUS_WITHOUT_COUNTRY.has(key)) {
    return null;
  }
  return result;
}

function germanDistrict(value) {
  const raw = cleanText(value).replace(/[.;]+$/gu, '');
  if (raw.length < 5 || raw.length > 120) return null;
  const prefix = /^(?:landkreis|kreis|stadtkreis|kreisfreie\s+stadt|region|städteregion|staedteregion|regionalverband)\s+[\p{L}\p{M}'’().\-/ ]+$/iu;
  const suffix = /^[\p{L}\p{M}'’().\-/ ]+\s+(?:landkreis|kreis)$/iu;
  if (!prefix.test(raw) && !suffix.test(raw)) return null;
  return regionEntry('DE', raw);
}

function phraseRegex(value) {
  const pieces = cleanText(value)
    .split(/\s+/u)
    .filter(Boolean)
    .map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${pieces.join('[\\s.,-]+')}(?![\\p{L}\\p{N}])`,
    'iu',
  );
}

export function resolveAdministrativeRegion(
  value,
  { countryCode = null, allowAmbiguous = false } = {},
) {
  return exactRegion(cleanText(value), countryCode, { allowAmbiguous })
    ?? ((countryCode == null || countryCode === 'DE') ? germanDistrict(value) : null);
}

export function findAdministrativeRegionMentions(
  value,
  { countryCode = null } = {},
) {
  const text = cleanText(value);
  if (text === '') return [];
  const found = new Map();

  for (const entry of ENTRIES) {
    if (countryCode && entry.countryCode !== countryCode) continue;
    for (const alias of entry.aliases) {
      const key = lookupKey(alias);
      if (!countryCode && AMBIGUOUS_WITHOUT_COUNTRY.has(key)) continue;
      // Two-letter state abbreviations are too noisy in prose. They are handled
      // only as exact comma-separated tokens by resolveAdministrativeRegion.
      if (/^[a-z]{2}$/u.test(key)) continue;
      if (!phraseRegex(alias).test(text)) continue;
      found.set(`${entry.countryCode}\u0000${entry.regionName}`, entry);
      break;
    }
  }

  const district = (countryCode == null || countryCode === 'DE')
    ? germanDistrict(text)
    : null;
  if (district) found.set(`DE\u0000${district.regionName}`, district);

  return [...found.values()];
}

export function administrativeRegionEntries() {
  return ENTRIES;
}
