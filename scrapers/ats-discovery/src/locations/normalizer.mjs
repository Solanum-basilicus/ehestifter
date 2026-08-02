import { getDefaultGeoDictionary, lookupKey } from './geo-dictionary.mjs';
import {
  findAdministrativeRegionMentions,
  resolveAdministrativeRegion,
} from './administrative-regions.mjs';
import { extractWorkTimeConstraints } from './work-time-constraints.mjs';

const NON_CITY_VALUES = new Set([
  'remote', 'fully remote', 'remote first', 'distributed', 'hybrid',
  'on site', 'onsite', 'office', 'home office', 'homeoffice',
  'worldwide', 'anywhere', 'global', 'globally', 'international',
]);

const DEFAULT_RESTRICTION_MARKERS = [
  'only', 'based', 'resident', 'residents', 'reside', 'residency',
  'located', 'living', 'live in', 'within', 'must be', 'must reside',
  'must live', 'candidates in', 'applicants in', 'hiring in',
  'remote from', 'remote in', 'eligible in', 'restricted to',
  'exclusively', 'work authorization', 'work authorisation',
  'work permit', 'right to work',
];

function cleanText(value) {
  return typeof value === 'string'
    ? value.replace(/\s+/gu, ' ').trim()
    : '';
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function phraseRegex(value) {
  const pieces = cleanText(value)
    .split(/\s+/u)
    .filter(Boolean)
    .map((piece) => escapeRegex(piece).replace(/\\\./gu, '\\.?'));
  if (pieces.length === 0) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])${pieces.join('[\\s.-]+')}(?![\\p{L}\\p{N}])`, 'iu');
}

function containsPhrase(text, value) {
  const pattern = phraseRegex(value);
  return pattern ? pattern.test(text) : false;
}

function firstMatchingTerm(text, terms) {
  for (const term of terms) {
    if (containsPhrase(text, term)) return term;
  }
  return null;
}

function workArrangementFromText(value) {
  const text = lookupKey(value);
  if (/\bhybrid\b/u.test(text)) return 'Hybrid';
  if (/\b(?:on site|onsite|office based)\b/u.test(text)) return 'On-Site';
  if (/\b(?:remote|distributed|home office|homeoffice)\b/u.test(text)) return 'Remote';
  return null;
}

function workArrangementFromTitle(value) {
  const title = cleanText(value);
  if (title === '') return null;

  const explicitSegments = [
    ...title.split(/\s*[|·•]\s*/u),
    ...[...title.matchAll(/[([]\s*([^()[\]]{2,40}?)\s*[)\]]/gu)]
      .map((match) => match[1]),
  ];
  for (const segment of explicitSegments) {
    const normalized = lookupKey(segment);
    if (/^(?:fully )?remote(?: first)?$/u.test(normalized)) return 'Remote';
    if (normalized === 'distributed') return 'Remote';
    if (normalized === 'hybrid') return 'Hybrid';
    if (/^(?:on site|onsite|office based)$/u.test(normalized)) return 'On-Site';
  }
  return null;
}

function workArrangementFromDescriptionPolicy(value) {
  const text = cleanText(value);
  if (text === '') return null;

  const match = text.match(
    /^(?:[-*•]\s*)?(?:location\s*(?:\/|&)\s*hybrid\s+policy|work(?:place)?\s+(?:arrangement|model)|working\s+model|remote\s+policy|location\s+policy)\s*[:\-–—]\s*(.{2,60})$/iu,
  );
  if (!match) return null;

  const normalized = lookupKey(match[1]);
  if (/^(?:fully )?remote(?: first)?$/u.test(normalized)) return 'Remote';
  if (normalized === 'distributed') return 'Remote';
  if (normalized === 'hybrid') return 'Hybrid';
  if (/^(?:on site|onsite|office based)$/u.test(normalized)) return 'On-Site';
  return null;
}

function stripArrangementWords(value) {
  return cleanText(value)
    .replace(/\b(?:fully\s+remote|remote[- ]first|remote|distributed|hybrid|on[- ]?site|onsite|home\s*office)\b/giu, ' ')
    .replace(/[()[\]]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/^[-,:/\s]+|[-,:/\s]+$/gu, '')
    .trim();
}

function stripLocalityQualifier(value) {
  return stripArrangementWords(value)
    .replace(/\s+(?:office|hq|headquarters)$/iu, '')
    .replace(/^(?:office|hq|headquarters)\s+/iu, '')
    .trim();
}

function isNonCity(value) {
  return NON_CITY_VALUES.has(lookupKey(value));
}

function locationKey(location) {
  return [
    location.countryCode,
    lookupKey(location.cityName),
    lookupKey(location.region),
  ].join('\u0000');
}

function dedupeLocations(locations) {
  const output = [];
  const seen = new Set();
  for (const location of locations) {
    if (!location) continue;
    const key = locationKey(location);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(location);
  }
  return output;
}

function collapseCountryOnlyLocations(locations) {
  const cityCountries = new Set(
    locations.filter((item) => item.cityName).map((item) => item.countryCode),
  );
  return locations.filter((item) => (
    item.cityName || item.region || !cityCountries.has(item.countryCode)
  ));
}

function splitLocationSegments(raw) {
  return cleanText(raw)
    .split(/\s*(?:[·;|\n]|\s+or\s+|\s+\/\s+)\s*/iu)
    .map(cleanText)
    .filter(Boolean);
}

function locationFromCountry(country, cityName = null, region = null) {
  return {
    ...country,
    cityName,
    region,
  };
}

function locationFromRegion(region, dictionary, cityName = null) {
  const country = dictionary.countryByCode(region.countryCode);
  return country
    ? locationFromCountry(country, cityName, region.regionName)
    : null;
}

function parseCityRegionPair(parts, dictionary, source, raw) {
  if (parts.length !== 2) return null;
  const [cityPart, regionPart] = parts;
  const region = resolveAdministrativeRegion(regionPart, { allowAmbiguous: true });
  if (!region) return null;
  const city = dictionary.resolveCity(cityPart, region.countryCode);
  const location = locationFromRegion(region, dictionary, city?.cityName ?? null);
  if (!location) return null;
  const unresolved = city
    ? []
    : [{ source, raw: cityPart, reason: 'city_unresolved_for_region_country' }];
  return {
    observations: [{
      source,
      raw,
      kind: city ? 'city_region_country' : 'region_country',
      status: 'resolved',
      location,
    }],
    locations: [location],
    unresolved,
  };
}

function parseRegionEvidence(value, dictionary, source, raw) {
  const exact = resolveAdministrativeRegion(value);
  const mentions = exact
    ? [exact]
    : findAdministrativeRegionMentions(value);
  const unique = new Map(
    mentions.map((item) => [`${item.countryCode}\u0000${item.regionName}`, item]),
  );
  if (unique.size !== 1) return null;
  const [region] = unique.values();
  const location = locationFromRegion(region, dictionary);
  if (!location) return null;
  return {
    observations: [{
      source,
      raw,
      kind: 'region_country',
      status: 'resolved',
      location,
    }],
    locations: [location],
    unresolved: [],
  };
}

function parseLocalities(values, country, dictionary, source, raw) {
  const observations = [];
  const locations = [];
  const unresolved = [];
  for (const value of values.map(stripLocalityQualifier).filter(Boolean)) {
    if (isNonCity(value)) continue;
    const city = dictionary.resolveCity(value, country.countryCode);
    if (city) {
      const location = locationFromCountry(country, city.cityName, null);
      locations.push(location);
      observations.push({
        source, raw, kind: 'city_country', status: 'resolved', location,
      });
    } else {
      unresolved.push({ source, raw: value, reason: 'city_unresolved_for_country' });
      observations.push({
        source, raw: value, kind: 'locality', status: 'unresolved',
        countryCode: country.countryCode,
      });
    }
  }
  if (locations.length === 0) {
    const location = locationFromCountry(country);
    locations.push(location);
    observations.push({
      source, raw, kind: 'country_scope', status: 'resolved', location,
    });
  }
  return { observations, locations, unresolved };
}

function parseSegment(segment, dictionary, source) {
  const raw = cleanText(segment);
  const arrangement = workArrangementFromText(raw);
  const cleaned = stripArrangementWords(raw);
  const observations = [];
  const locations = [];
  const unresolved = [];

  if (cleaned === '' && arrangement) {
    return {
      observations: [{
        source, raw, kind: 'work_arrangement', status: 'resolved', arrangement,
      }],
      locations,
      unresolved,
      arrangement,
    };
  }

  const exactCountry = dictionary.resolveCountry(cleaned);
  if (exactCountry) {
    const location = locationFromCountry(exactCountry);
    return {
      observations: [{ source, raw, kind: 'country_scope', status: 'resolved', location }],
      locations: [location], unresolved, arrangement,
    };
  }

  const colonParts = cleaned.split(/\s*:\s*/u).map(cleanText).filter(Boolean);
  if (colonParts.length === 2) {
    const leftCountry = dictionary.resolveCountry(colonParts[0]);
    const rightCountry = dictionary.resolveCountry(colonParts[1]);
    if (leftCountry) {
      return {
        ...parseLocalities(
          colonParts[1].split(/\s*,\s*/u),
          leftCountry,
          dictionary,
          source,
          raw,
        ),
        arrangement,
      };
    }
    if (rightCountry) {
      return {
        ...parseLocalities(
          colonParts[0].split(/\s*,\s*/u),
          rightCountry,
          dictionary,
          source,
          raw,
        ),
        arrangement,
      };
    }
  }

  const commaParts = cleaned.split(/\s*,\s*/u).map(cleanText).filter(Boolean);
  const countries = commaParts
    .map((part, index) => ({ index, country: dictionary.resolveCountry(part) }))
    .filter((item) => item.country);
  if (countries.length === 1) {
    const { index, country } = countries[0];
    return {
      ...parseLocalities(
        commaParts.filter((_part, partIndex) => partIndex !== index),
        country,
        dictionary,
        source,
        raw,
      ),
      arrangement,
    };
  }

  const cityRegion = parseCityRegionPair(commaParts, dictionary, source, raw);
  if (cityRegion) return { ...cityRegion, arrangement };

  const region = parseRegionEvidence(cleaned, dictionary, source, raw);
  if (region) return { ...region, arrangement };

  const wordsCountry = dictionary.resolveCountry(cleaned.replace(/\b(?:remote|hybrid|on[- ]?site)\b/giu, ' '));
  if (wordsCountry) {
    const location = locationFromCountry(wordsCountry);
    return {
      observations: [{ source, raw, kind: 'country_scope', status: 'resolved', location }],
      locations: [location], unresolved, arrangement,
    };
  }

  unresolved.push({ source, raw, reason: 'segment_unresolved' });
  observations.push({ source, raw, kind: 'unknown', status: 'unresolved' });
  return { observations, locations, unresolved, arrangement };
}

export function normalizeRawLocation(
  rawLocation,
  {
    dictionary = getDefaultGeoDictionary(),
    source = 'raw_location',
  } = {},
) {
  const raw = cleanText(rawLocation);
  if (raw === '') {
    return { status: 'missing', locations: [], observations: [], unresolved: [] };
  }

  const segments = splitLocationSegments(raw);
  let parsed = segments.map((segment) => parseSegment(segment, dictionary, source));

  // Explicit countries in the same provider field may qualify sibling city-only
  // segments. With one country this covers "Berlin · Munich, Germany". With
  // several countries, resolve only when the city exists in exactly one of the
  // listed countries; this keeps "Berlin Office · ... · Germany" useful
  // without guessing a country for a standalone city such as "Hamburg".
  const resolvedCountryCodes = new Set(
    parsed.flatMap((item) => item.locations.map((location) => location.countryCode)),
  );
  if (resolvedCountryCodes.size > 0) {
    parsed = parsed.map((item, index) => {
      if (item.locations.length > 0 || item.unresolved.length !== 1) return item;
      const rawSegment = segments[index];
      const locality = stripLocalityQualifier(rawSegment);
      if (locality === '' || /[:,]/u.test(locality) || isNonCity(locality)) return item;

      const matches = [];
      for (const countryCode of resolvedCountryCodes) {
        const city = dictionary.resolveCity(locality, countryCode);
        if (city) matches.push(city);
      }
      const uniqueMatches = new Map(
        matches.map((city) => [city.countryCode, city]),
      );
      if (uniqueMatches.size !== 1) return item;

      const [city] = uniqueMatches.values();
      const country = dictionary.countryByCode(city.countryCode);
      const location = locationFromCountry(country, city.cityName, null);
      return {
        observations: [{
          source,
          raw: rawSegment,
          kind: resolvedCountryCodes.size === 1
            ? 'city_with_shared_country'
            : 'city_with_listed_country',
          status: 'resolved',
          location,
        }],
        locations: [location],
        unresolved: [],
        arrangement: item.arrangement,
      };
    });
  }

  const locations = collapseCountryOnlyLocations(dedupeLocations(parsed.flatMap((item) => item.locations)));
  const observations = parsed.flatMap((item) => item.observations);
  const unresolved = parsed.flatMap((item) => item.unresolved);
  const arrangement = parsed.map((item) => item.arrangement).find(Boolean) ?? null;

  let status;
  if (locations.length === 0) status = segments.length > 1 ? 'unparsed_multiple' : 'unparsed_single_value';
  else if (segments.length > 1 || locations.length > 1) status = 'normalized_multiple';
  else if (locations[0].cityName) status = 'normalized_city_country';
  else if (arrangement === 'Remote') status = 'normalized_country_scope';
  else status = 'normalized_country';

  return { status, locations, observations, unresolved, arrangement };
}

function normalizeStructuredLocations(candidate, dictionary) {
  const observations = [];
  const locations = [];
  const unresolved = [];
  for (const item of candidate.locations ?? []) {
    const result = dictionary.canonicalizeLocation(item);
    if (result.location) locations.push(result.location);
    observations.push({
      source: 'provider_structured',
      raw: item,
      kind: 'structured_location',
      status: result.location ? 'resolved' : 'unresolved',
      location: result.location,
      issues: result.unresolved,
    });
    for (const reason of result.unresolved) {
      unresolved.push({ source: 'provider_structured', raw: item, reason });
    }
  }
  return {
    status: 'provider_structured',
    locations: collapseCountryOnlyLocations(dedupeLocations(locations)),
    observations,
    unresolved,
    arrangement: workArrangementFromText(candidate.remoteType),
  };
}

function descriptionWindows(description) {
  if (typeof description !== 'string' || description.trim() === '') return [];
  const text = description
    .replace(/<br\s*\/?\s*>/giu, '\n')
    .replace(/<\/(?:p|li|div|section|article|h[1-6])\s*>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t\f\v]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .trim();
  if (text === '') return [];
  return text
    .split(/(?:\n+|(?<=[.!?;])\s+)/u)
    .map(cleanText)
    .filter((item) => item.length >= 4)
    .map((item) => item.slice(0, 500));
}

function extractDeclaredLocationText(window) {
  const text = cleanText(window).replace(/[.;]+$/u, '');
  const patterns = [
    /\b(?:work\s+)?location\s*[:\-–—]\s*(.{2,120})$/iu,
    /\b(?:role|position|job)\s+is\s+based\s+(?:in|at)\s+(.{2,100})$/iu,
    /^(?:based|located)\s+(?:in|at)\s+(.{2,100})$/iu,
    /\b(?:presence|attendance)\s+(?:in|at)\s+(?:our\s+)?(.{2,100}?)(?:\s+(?:office|hq|headquarters))?$/iu,
    /\bwork(?:\s+[\p{L}\p{N}-]+){0,10}\s+from\s+(?:our\s+)?(.{2,100}?)(?:\s+(?:office|hq|headquarters))?$/iu,
    /\b(?:once[- ]a[- ]week|weekly|\d+\s*(?:days?|times?)\s+(?:a|per)\s+week|required|mandatory|expected)\b.{0,100}\b(?:in|at)\s+(?:our\s+)?(.{2,100}?)(?:\s+(?:office|hq|headquarters))$/iu,
    /\b(?:you|employee|candidate|applicant|must|required|mandatory|expected)\b.{0,80}\b(?:based|located)\s+(?:in|at)\s+(.{2,100})$/iu,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return cleanText(match[1])
        .replace(/\s+(?:office|hq|headquarters)$/iu, '')
        .replace(/[.;]+$/u, '');
    }
  }
  return null;
}

function mandatoryPresence(window) {
  return /\b(?:must|required|mandatory|expected|at least|once[- ]a[- ]week|weekly|\d+\s*(?:days?|times?)\s+(?:a|per)\s+week)\b.{0,120}\b(?:office|hq|headquarters|on[- ]?site|onsite|presence|attendance|work\s+from)\b/iu.test(window)
    || /\b(?:office|hq|headquarters|on[- ]?site|onsite|presence|attendance)\b.{0,120}\b(?:must|required|mandatory|expected|at least|once[- ]a[- ]week|weekly|\d+\s*(?:days?|times?)\s+(?:a|per)\s+week)\b/iu.test(window);
}

function explicitLocationDeclaration(window) {
  return /^(?:[-*•]\s*)?(?:work\s+)?location\s*[:\-–—]/iu.test(window)
    || /\b(?:role|position|job)\s+is\s+based\s+(?:in|at)\b/iu.test(window)
    || /^(?:based|located)\s+(?:in|at)\b/iu.test(window);
}

function resolvedScopeLocations(terms, dictionary, source, context) {
  const locations = [];
  const observations = [];
  for (const term of terms.filter(Boolean)) {
    const country = dictionary.resolveCountry(term);
    if (!country) continue;
    const location = locationFromCountry(country);
    locations.push(location);
    observations.push({
      source,
      raw: term,
      kind: 'eligibility_scope_location',
      status: 'resolved',
      location,
      context,
    });
  }
  return { locations, observations };
}

function matchingScopeTerm(text, configuredTerms, dictionary) {
  const direct = firstMatchingTerm(text, configuredTerms);
  if (direct) return direct;
  const configuredCountryCodes = new Set(
    configuredTerms
      .map((term) => dictionary.resolveCountry(term)?.countryCode)
      .filter(Boolean),
  );
  for (const mention of dictionary.findCountryMentions(text)) {
    if (configuredCountryCodes.has(mention.countryCode)) {
      return mention.matchedTerm;
    }
  }
  return null;
}

function effectiveAllowedScopeTerm(text, allowedTerm) {
  if (!allowedTerm) return null;
  if (
    lookupKey(allowedTerm) === 'anywhere'
    && /\banywhere\s+(?:in|within)\b/iu.test(text)
  ) {
    return null;
  }
  return allowedTerm;
}

function providerScopeEvidence(candidate, dictionary, scopeFilter) {
  const raw = cleanText(candidate.rawLocation);
  if (raw === '') return { locations: [], observations: [], eligibilityEvidence: [] };
  const excludesGermany = /\b(?:excluding|exclude|except|not\s+available\s+in|not\s+hiring\s+in|outside|not\s+in)\s+(?:germany|deutschland)\b/iu.test(raw);
  if (excludesGermany) {
    return {
      locations: [],
      observations: [],
      eligibilityEvidence: [{
        source: 'raw_location',
        kind: 'explicit_exclusion',
        disposition: 'incompatible',
        text: raw,
      }],
    };
  }
  const allowedTerm = matchingScopeTerm(
    raw, scopeFilter?.allow ?? [], dictionary,
  );
  const effectiveAllowedTerm = effectiveAllowedScopeTerm(raw, allowedTerm);
  const blockedTerm = matchingScopeTerm(
    raw, scopeFilter?.block ?? [], dictionary,
  );
  if (!effectiveAllowedTerm && !blockedTerm) {
    return { locations: [], observations: [], eligibilityEvidence: [] };
  }
  const scopeLocations = resolvedScopeLocations(
    [effectiveAllowedTerm, blockedTerm], dictionary, 'raw_location', raw,
  );
  return {
    ...scopeLocations,
    eligibilityEvidence: [{
      source: 'raw_location',
      kind: 'provider_location_scope',
      disposition: blockedTerm && !effectiveAllowedTerm ? 'incompatible' : 'compatible',
      allowTerm: effectiveAllowedTerm,
      blockTerm: blockedTerm,
      text: raw,
    }],
  };
}

function negatesRequirement(text) {
  return /\b(?:is|are|be|was|were)\s+not\s+(?:required|mandatory|expected|needed)\b/iu.test(text)
    || /\bno\b.{0,80}\b(?:required|mandatory|needed|requirement)\b/iu.test(text)
    || /\b(?:does|do|will)\s+not\s+require\b/iu.test(text)
    || /\bwithout\b.{0,50}\brequir(?:e|ed|ement)\b/iu.test(text);
}

function employerCountryHints(window, dictionary) {
  const employerContext = /\b(?:we\s+(?:are|'re)|our\s+(?:company|business|headquarters|hq)|company\s+(?:is|was)|headquartered|headquarters|hq)\b/iu.test(window)
    && /\b(?:company|companies|business|employer|organisation|organization|fintech|headquartered|headquarters|hq|based)\b/iu.test(window);
  const hints = employerContext
    ? dictionary.findCountryMentions(window)
    : [];

  // These are deliberately high-signal US employment markers. They are not
  // locations on their own; they may only disambiguate a provider locality.
  if (/\b401\s*\(?k\)?\b/iu.test(window)
    || /\b(?:public\s+trust|ofccp|federal\s+contractor|w-?2\s+employee)\b/iu.test(window)) {
    const us = dictionary.countryByCode('US');
    if (us) hints.push({ ...us, matchedTerm: 'us_employment_signal' });
  }

  return hints.map((country) => ({
    countryName: country.countryName,
    countryCode: country.countryCode,
    matchedTerm: country.matchedTerm,
    text: window,
  }));
}

function citizenshipScope(window, dictionary, allowedTerm, blockedTerm) {
  if (negatesRequirement(window)) return null;
  if (!/\b(?:citizens?|citizenship)\b/iu.test(window)) return null;
  if (!/\b(?:only|must|required|requirement|eligible|opportunity)\b/iu.test(window)) return null;
  const mentionedCountries = dictionary.findCountryMentions(window);
  const uniqueCountries = new Map(
    mentionedCountries.map((item) => [item.countryCode, item]),
  );
  if (uniqueCountries.size !== 1) return null;
  const [mention] = uniqueCountries.values();
  const country = {
    countryName: mention.countryName,
    countryCode: mention.countryCode,
  };
  const term = blockedTerm ?? allowedTerm ?? mention.matchedTerm;
  return {
    country,
    term,
    disposition: blockedTerm && !allowedTerm
      ? 'incompatible'
      : allowedTerm
        ? 'compatible'
        : 'location_constraint',
  };
}

function providerLocalityRefinement(candidate, countryHints, dictionary) {
  const hintCodes = [...new Set(countryHints.map((item) => item.countryCode))];
  if (hintCodes.length !== 1) {
    return {
      locations: [], observations: [], unresolved: [], supersededCountryCodes: [],
    };
  }
  const [countryCode] = hintCodes;
  const country = dictionary.countryByCode(countryCode);
  if (!country) {
    return {
      locations: [], observations: [], unresolved: [], supersededCountryCodes: [],
    };
  }

  const rawValues = [candidate.rawLocation, candidate.detailRawLocation]
    .map(cleanText)
    .filter(Boolean);
  const locations = [];
  const observations = [];
  const unresolved = [];
  const supersededCountryCodes = new Set();
  for (const rawValue of rawValues) {
    for (const segment of splitLocationSegments(rawValue)) {
      const locality = stripLocalityQualifier(segment)
        .replace(/^(?:location\s*[:\-–—]\s*|if\s+local\s+to\s+|local\s+to\s+)/iu, '')
        .trim();
      if (locality === '' || /[:,]/u.test(locality) || isNonCity(locality)) continue;
      const namedCountry = dictionary.resolveCountry(locality);
      const hintedRegion = resolveAdministrativeRegion(locality, { countryCode });
      const regionDisambiguatesCountryName = namedCountry
        && namedCountry.countryCode !== countryCode
        && hintedRegion;
      if (regionDisambiguatesCountryName) {
        supersededCountryCodes.add(namedCountry.countryCode);
      }
      const city = regionDisambiguatesCountryName
        ? null
        : dictionary.resolveCity(locality, countryCode);
      const location = city
        ? locationFromCountry(country, city.cityName, null)
        : hintedRegion
          ? locationFromRegion(hintedRegion, dictionary)
          : null;
      if (!location) continue;
      locations.push(location);
      observations.push({
        source: 'description',
        raw: locality,
        kind: city
          ? 'provider_city_with_description_country_hint'
          : 'provider_region_with_description_country_hint',
        status: 'resolved',
        location,
        countryHints: countryHints.filter((item) => item.countryCode === countryCode),
      });
    }
  }
  return {
    locations: dedupeLocations(locations),
    observations,
    unresolved,
    supersededCountryCodes: [...supersededCountryCodes],
  };
}

function descriptionEvidence(candidate, primaryLocations, dictionary, scopeFilter) {
  const allow = Array.isArray(scopeFilter?.allow) ? scopeFilter.allow : [];
  const block = Array.isArray(scopeFilter?.block) ? scopeFilter.block : [];
  const markers = Array.isArray(scopeFilter?.restriction_markers)
    ? scopeFilter.restriction_markers
    : DEFAULT_RESTRICTION_MARKERS;
  const windows = descriptionWindows(candidate.description);
  const observations = [];
  const locations = [];
  const unresolved = [];
  const eligibilityEvidence = [];
  const descriptionArrangements = [];
  const countryHints = [];
  const primaryCountries = [...new Set(primaryLocations.map((item) => item.countryCode))];

  for (const window of windows) {
    countryHints.push(...employerCountryHints(window, dictionary));
    const descriptionArrangement = workArrangementFromDescriptionPolicy(window);
    if (descriptionArrangement) {
      descriptionArrangements.push(descriptionArrangement);
      observations.push({
        source: 'description',
        raw: window,
        kind: 'work_arrangement',
        status: 'resolved',
        arrangement: descriptionArrangement,
        context: window,
      });
    }
    const configuredMarker = firstMatchingTerm(window, markers);
    const marker = configuredMarker
      ?? (/\bauthori[sz](?:ed|ation)\s+to\s+work\b/iu.test(window)
        ? 'authorized to work'
        : null);
    const allowedTerm = matchingScopeTerm(window, allow, dictionary);
    const blockedTerm = matchingScopeTerm(window, block, dictionary);
    const effectiveAllowedTerm = effectiveAllowedScopeTerm(window, allowedTerm);
    const explicitScope = /\b(?:open\s+to|eligible|hiring|candidates?|applicants?|opportunity|remote|reside|residents?|citizens?|citizenship|work\s+authori[sz]ation|authori[sz](?:ed|ation)\s+to\s+work|right\s+to\s+work|work\s+permit|restricted)\b/iu.test(window);
    const roleConstraintContext = /\b(?:role|position|job|you|employee|must|required|mandatory|expected)\b/iu.test(window)
      || (/^based\s+in\b/iu.test(window) && window.length <= 120);
    const basedConstraintContext = /\bbased\b.{0,35}\b(?:candidates?|applicants?|employees?)\b/iu.test(window)
      || /\b(?:role|position|job|candidates?|applicants?|employees?)\b.{0,25}\b(?:is|are|must\s+be|need\s+to\s+be|will\s+be|should\s+be|required\s+to\s+be)\b.{0,10}\bbased\b/iu.test(window)
      || /\byou\b.{0,20}\b(?:are|must|need\s+to|will|should)\b.{0,15}\bbased\b/iu.test(window)
      || (/^based\s+(?:in|at)\b/iu.test(window) && window.length <= 120);
    const normalizedWindow = lookupKey(window);
    const configuredScopeCodes = new Set(
      [effectiveAllowedTerm, blockedTerm]
        .map((term) => dictionary.resolveCountry(term)?.countryCode)
        .filter(Boolean),
    );
    const onlyScopeTerms = [
      effectiveAllowedTerm,
      blockedTerm,
      ...dictionary.findCountryMentions(window)
        .filter((item) => configuredScopeCodes.has(item.countryCode))
        .map((item) => item.matchedTerm),
    ];
    const onlyNearScope = [...new Set(onlyScopeTerms.filter(Boolean))]
      .some((term) => {
        const normalizedTerm = escapeRegex(lookupKey(term)).replace(/ /gu, '\\s+');
        if (normalizedTerm === '') return false;
        return new RegExp(
          `(?:^|\\s)(?:only|exclusively)\\s+${normalizedTerm}(?:$|\\s)|(?:^|\\s)${normalizedTerm}\\s+(?:only|exclusively)(?:$|\\s)`,
          'iu',
        ).test(normalizedWindow);
      });
    const onlyConstraintContext = onlyNearScope
      || /\b(?:only|exclusively)\b.{0,35}\b(?:based|located|residents?|reside|residency|living|live\s+in|candidates?\s+in|applicants?\s+in|remote\s+(?:from|in)|eligible\s+in|restricted\s+to)\b/iu.test(window)
      || /\b(?:based|located|residents?|reside|residency|living|live\s+in|remote|hiring|eligible|restricted)\b.{0,35}\b(?:only|exclusively)\b/iu.test(window);
    const markerHasConstraintContext = marker === 'based'
      ? basedConstraintContext
      : marker === 'only' || marker === 'exclusively'
        ? onlyConstraintContext
        : true;
    const requirementNegated = negatesRequirement(window);
    const excludesGermany = /\b(?:excluding|exclude|except|not\s+available\s+in|not\s+hiring\s+in|outside|not\s+in)\s+(?:germany|deutschland)\b/iu.test(window);
    const citizenship = citizenshipScope(
      window,
      dictionary,
      effectiveAllowedTerm,
      blockedTerm,
    );

    if (excludesGermany) {
      eligibilityEvidence.push({
        source: 'description', kind: 'explicit_exclusion', disposition: 'incompatible', text: window,
      });
    } else if (citizenship) {
      eligibilityEvidence.push({
        source: 'description',
        kind: 'citizenship_scope',
        disposition: citizenship.disposition,
        allowTerm: effectiveAllowedTerm,
        blockTerm: blockedTerm,
        marker: 'citizenship',
        locations: [locationFromCountry(citizenship.country)],
        text: window,
      });
      const location = locationFromCountry(citizenship.country);
      locations.push(location);
      observations.push({
        source: 'description',
        raw: citizenship.term,
        kind: 'eligibility_scope_location',
        status: 'resolved',
        location,
        context: window,
      });
    } else if (
      !requirementNegated
      && (explicitScope || roleConstraintContext)
      && marker
      && markerHasConstraintContext
      && (effectiveAllowedTerm || blockedTerm)
    ) {
      eligibilityEvidence.push({
        source: 'description',
        kind: marker ? 'restriction_scope' : 'explicit_scope',
        disposition: blockedTerm && !effectiveAllowedTerm ? 'incompatible' : 'compatible',
        allowTerm: effectiveAllowedTerm,
        blockTerm: blockedTerm,
        marker,
        text: window,
      });
      const scopeLocations = resolvedScopeLocations(
        [effectiveAllowedTerm, blockedTerm], dictionary, 'description', window,
      );
      locations.push(...scopeLocations.locations);
      observations.push(...scopeLocations.observations);
    }

    const declared = extractDeclaredLocationText(window);
    if (!declared) continue;
    let parsed = normalizeRawLocation(declared, { dictionary });
    if (parsed.locations.length === 0 && primaryCountries.length === 1) {
      const city = dictionary.resolveCity(stripArrangementWords(declared), primaryCountries[0]);
      if (city) {
        const country = dictionary.countryByCode(city.countryCode);
        const location = locationFromCountry(country, city.cityName, null);
        parsed = {
          status: 'normalized_city_country',
          locations: [location],
          observations: [{
            source: 'description', raw: declared, kind: 'city_with_primary_country',
            status: 'resolved', location,
          }],
          unresolved: [],
        };
      }
    }
    for (const observation of parsed.observations) {
      observations.push({ ...observation, source: 'description', context: window });
    }
    for (const location of parsed.locations) locations.push(location);
    for (const item of parsed.unresolved) unresolved.push({ ...item, source: 'description', context: window });

    if (
      !requirementNegated
      && explicitLocationDeclaration(window)
      && parsed.locations.length > 0
    ) {
      eligibilityEvidence.push({
        source: 'description',
        kind: 'declared_location',
        disposition: 'location_constraint',
        locations: parsed.locations,
        text: window,
      });
    }

    if (!requirementNegated && mandatoryPresence(window)) {
      if (parsed.locations.length > 0) {
        eligibilityEvidence.push({
          source: 'description', kind: 'mandatory_presence', disposition: 'location_constraint',
          locations: parsed.locations, text: window,
        });
      } else {
        eligibilityEvidence.push({
          source: 'description', kind: 'mandatory_presence_unresolved', disposition: 'unclear',
          text: window,
        });
      }
    }
  }

  const uniqueDescriptionArrangements = [...new Set(descriptionArrangements)];
  return {
    observations,
    locations: collapseCountryOnlyLocations(dedupeLocations(locations)),
    unresolved,
    eligibilityEvidence,
    arrangement: uniqueDescriptionArrangements.length === 1
      ? uniqueDescriptionArrangements[0]
      : null,
    arrangementConflict: uniqueDescriptionArrangements.length > 1,
    countryHints,
  };
}

function reconcileLocations(primary, secondary) {
  const primaryCodes = new Set(primary.map((item) => item.countryCode));
  const secondaryCodes = new Set(secondary.map((item) => item.countryCode));
  let consistency = 'insufficient';

  if (primary.length > 0 && secondary.length === 0) consistency = 'consistent';
  else if (primary.length === 0 && secondary.length > 0) consistency = 'refined';
  else if (primary.length > 0 && secondary.length > 0) {
    const overlap = [...secondaryCodes].some((code) => primaryCodes.has(code));
    consistency = overlap ? 'refined' : 'conflicting';
  }

  const combined = collapseCountryOnlyLocations(dedupeLocations([
    ...primary,
    ...secondary,
  ]));
  return { locations: combined, consistency };
}

function combineConsistency(...values) {
  if (values.includes('conflicting')) return 'conflicting';
  if (values.includes('refined')) return 'refined';
  if (values.includes('consistent')) return 'consistent';
  return 'insufficient';
}

function assessEligibility(candidate, locations, consistency, evidence, scopeFilter, dictionary) {
  if (candidate.preflight?.status === 'ok' && candidate.preflight.exists) {
    return {
      schemaVersion: 1,
      status: 'not_applicable_existing',
      reason: 'existing_job_not_reassessed',
      consistency,
      evidence,
    };
  }

  if (!scopeFilter) {
    return {
      schemaVersion: 1,
      status: 'unclear',
      reason: 'location_scope_filter_disabled',
      consistency,
      evidence,
    };
  }

  const incompatible = evidence.find((item) => item.disposition === 'incompatible');
  if (incompatible) {
    return {
      schemaVersion: 1,
      status: 'ineligible',
      reason: incompatible.kind,
      consistency,
      evidence,
    };
  }

  const blockedCountries = new Set();
  for (const term of scopeFilter?.block ?? []) {
    const country = dictionary.resolveCountry(term);
    if (country) blockedCountries.add(country.countryCode);
  }
  const compatibleCountries = new Set();
  for (const term of scopeFilter?.allow ?? []) {
    const country = dictionary.resolveCountry(term);
    if (country) compatibleCountries.add(country.countryCode);
  }

  const mandatory = evidence.filter((item) => item.kind === 'mandatory_presence');
  for (const item of mandatory) {
    if (item.locations?.some((location) => blockedCountries.has(location.countryCode))) {
      return {
        schemaVersion: 1,
        status: 'ineligible',
        reason: 'mandatory_incompatible_office_presence',
        consistency,
        evidence,
      };
    }
  }

  const explicitLocationConstraints = evidence.filter((item) => (
    item.kind === 'declared_location'
    || (
      item.kind === 'citizenship_scope'
      && item.disposition === 'location_constraint'
    )
  ));
  for (const item of explicitLocationConstraints) {
    const codes = item.locations?.map((location) => location.countryCode) ?? [];
    if (
      codes.length > 0
      && codes.every((code) => blockedCountries.has(code))
      && !codes.some((code) => compatibleCountries.has(code) || code === 'DE')
    ) {
      return {
        schemaVersion: 1,
        status: 'ineligible',
        reason: 'declared_incompatible_location',
        consistency,
        evidence,
      };
    }
  }

  const arrangement = workArrangementFromText(candidate.remoteType)
    ?? workArrangementFromText(candidate.rawLocation);
  const concreteCodes = locations
    .map((item) => item.countryCode)
    .filter((code) => code !== 'EU');
  if (
    (arrangement === 'On-Site' || arrangement === 'Hybrid')
    && concreteCodes.length > 0
    && concreteCodes.every((code) => blockedCountries.has(code))
  ) {
    return {
      schemaVersion: 1,
      status: 'ineligible',
      reason: 'explicit_incompatible_work_location',
      consistency,
      evidence,
    };
  }

  if (evidence.some((item) => item.kind === 'mandatory_presence_unresolved')) {
    return {
      schemaVersion: 1,
      status: 'unclear',
      reason: 'mandatory_presence_location_unresolved',
      consistency,
      evidence,
    };
  }

  if (consistency === 'conflicting') {
    return {
      schemaVersion: 1,
      status: 'unclear',
      reason: 'conflicting_without_decisive_restriction',
      consistency,
      evidence,
    };
  }

  const compatibleEvidence = evidence.some((item) => item.disposition === 'compatible')
    || locations.some((item) => item.countryCode === 'DE' || compatibleCountries.has(item.countryCode));
  if (compatibleEvidence) {
    return {
      schemaVersion: 1,
      status: 'eligible',
      reason: 'compatible_location_evidence',
      consistency,
      evidence,
    };
  }

  return {
    schemaVersion: 1,
    status: 'unclear',
    reason: consistency === 'conflicting'
      ? 'conflicting_without_decisive_restriction'
      : 'insufficient_explicit_location_evidence',
    consistency,
    evidence,
  };
}

export function normalizeCandidateLocations(
  candidates,
  {
    dictionary = getDefaultGeoDictionary(),
    locationScopeFilter = null,
  } = {},
) {
  const activeScopeFilter = locationScopeFilter?.enabled === false
    ? null
    : locationScopeFilter;
  return candidates.map((candidate) => {
    const hasStructured = Array.isArray(candidate.locations) && candidate.locations.length > 0;
    const rawPrimary = normalizeRawLocation(candidate.rawLocation, {
      dictionary,
      source: 'raw_location',
    });
    const detailRawPrimary = normalizeRawLocation(candidate.detailRawLocation, {
      dictionary,
      source: 'provider_detail_location',
    });
    const rawReconciliation = detailRawPrimary.status === 'missing'
      ? { locations: rawPrimary.locations, consistency: 'insufficient' }
      : reconcileLocations(rawPrimary.locations, detailRawPrimary.locations);
    const structuredPrimary = hasStructured
      ? normalizeStructuredLocations(candidate, dictionary)
      : null;
    const providerReconciliation = structuredPrimary
      ? reconcileLocations(structuredPrimary.locations, rawReconciliation.locations)
      : rawReconciliation;
    const primary = structuredPrimary ? {
      status: structuredPrimary.status,
      locations: providerReconciliation.locations,
      observations: [
        ...structuredPrimary.observations,
        ...rawPrimary.observations,
        ...detailRawPrimary.observations,
      ],
      unresolved: [
        ...structuredPrimary.unresolved,
        ...rawPrimary.unresolved,
        ...detailRawPrimary.unresolved,
      ],
      arrangement: structuredPrimary.arrangement
        ?? rawPrimary.arrangement
        ?? detailRawPrimary.arrangement,
    } : {
      status: rawPrimary.status !== 'missing'
        ? rawPrimary.status
        : detailRawPrimary.status,
      locations: providerReconciliation.locations,
      observations: [
        ...rawPrimary.observations,
        ...detailRawPrimary.observations,
      ],
      unresolved: [
        ...rawPrimary.unresolved,
        ...detailRawPrimary.unresolved,
      ],
      arrangement: rawPrimary.arrangement ?? detailRawPrimary.arrangement,
    };
    const providerScope = providerScopeEvidence(
      candidate,
      dictionary,
      activeScopeFilter,
    );
    const primaryLocations = collapseCountryOnlyLocations(dedupeLocations([
      ...primary.locations,
      ...providerScope.locations,
    ]));
    const description = descriptionEvidence(
      candidate,
      primaryLocations,
      dictionary,
      activeScopeFilter,
    );
    const providerLocality = providerLocalityRefinement(
      candidate,
      description.countryHints,
      dictionary,
    );
    const refinementPrimaryLocations = primaryLocations.filter((location) => (
      !providerLocality.supersededCountryCodes.includes(location.countryCode)
    ));
    const descriptionReconciliation = reconcileLocations(
      refinementPrimaryLocations,
      [...description.locations, ...providerLocality.locations],
    );
    const explicitArrangement = workArrangementFromText(candidate.remoteType);
    const titleArrangement = workArrangementFromTitle(candidate.title);
    const strongerArrangement = explicitArrangement
      ?? primary.arrangement
      ?? titleArrangement;
    const arrangementConsistency = description.arrangementConflict
      ? 'conflicting'
      : description.arrangement && strongerArrangement
        ? description.arrangement === strongerArrangement
          ? 'consistent'
          : 'conflicting'
        : description.arrangement
          ? 'refined'
          : 'insufficient';
    const reconciled = {
      ...descriptionReconciliation,
      consistency: combineConsistency(
        providerReconciliation.consistency,
        rawReconciliation.consistency,
        descriptionReconciliation.consistency,
        arrangementConsistency,
      ),
    };
    const eligibilityEvidence = [
      ...providerScope.eligibilityEvidence,
      ...description.eligibilityEvidence,
    ];
    const resolvedArrangement = strongerArrangement
      ?? description.arrangement;
    const remoteType = resolvedArrangement
      ?? (cleanText(candidate.remoteType) || 'Unknown');
    const titleObservations = (
      titleArrangement
      && !explicitArrangement
      && !primary.arrangement
    ) ? [{
        source: 'title',
        raw: cleanText(candidate.title),
        kind: 'work_arrangement',
        status: 'resolved',
        arrangement: titleArrangement,
      }] : [];
    const eligibility = assessEligibility(
      { ...candidate, remoteType },
      reconciled.locations,
      reconciled.consistency,
      eligibilityEvidence,
      activeScopeFilter,
      dictionary,
    );
    const workTimeConstraints = extractWorkTimeConstraints(candidate.description);

    return {
      ...candidate,
      remoteType,
      locations: reconciled.locations,
      locationNormalization: {
        schemaVersion: 2,
        status: primary.status,
        consistency: reconciled.consistency,
        rawLocation: cleanText(candidate.rawLocation) || null,
        detailRawLocation: cleanText(candidate.detailRawLocation) || null,
        observations: [
          ...primary.observations,
          ...titleObservations,
          ...providerScope.observations,
          ...description.observations,
          ...providerLocality.observations,
        ],
        unresolved: [
          ...primary.unresolved,
          ...description.unresolved,
          ...providerLocality.unresolved,
        ],
      },
      locationEligibility: eligibility,
      workTimeConstraints,
    };
  });
}
