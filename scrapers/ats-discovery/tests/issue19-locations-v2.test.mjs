import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeCandidateLocations } from '../src/locations/normalizer.mjs';
import {
  annotatePreliminaryDiscoveryEligibility,
  applyDiscoveryEligibility,
  evaluateDiscoveryEligibility,
  isDefinitePreliminaryGeographyMismatch,
} from '../src/locations/discovery-eligibility.mjs';
import { createLocationsV2Catalog, getDefaultLocationsV2Catalog } from '../src/locations/locations-v2-catalog.mjs';

const catalog = getDefaultLocationsV2Catalog();

function candidate(overrides = {}) {
  return {
    title: 'Engineering Manager',
    rawLocation: '',
    detailRawLocation: '',
    locations: [],
    remoteType: 'Remote',
    description: '',
    preflight: { status: 'ok', exists: false },
    matchedUserIds: ['11111111-1111-4111-8111-111111111111'],
    ...overrides,
  };
}

function user(group) {
  return {
    userId: '11111111-1111-4111-8111-111111111111',
    discoveryPreferences: {
      schemaVersion: 1,
      title: { positive: ['Engineering Manager'], positivePatterns: [], negative: [] },
      eligibility: { remote: group },
    },
  };
}

test('normalization emits canonical city identities and disambiguates state abbreviations', () => {
  const [paloAlto] = normalizeCandidateLocations([
    candidate({ rawLocation: 'Palo Alto, CA', remoteType: 'On-Site' }),
  ]);
  assert.deepEqual(paloAlto.locations, [{
    countryName: 'United States', countryCode: 'US', cityName: 'Palo Alto', region: 'California',
  }]);
  assert.deepEqual(paloAlto.locationsV2, [{ kind: 'city', locationId: 'geonames:5380748' }]);

  const [toronto] = normalizeCandidateLocations([
    candidate({ rawLocation: 'Toronto, CA', remoteType: 'On-Site' }),
  ]);
  assert.deepEqual(toronto.locationsV2, [{ kind: 'city', locationId: 'geonames:6167865' }]);
});

test('dominant city resolution makes Remote Dallas a canonical v2 city', () => {
  const [result] = normalizeCandidateLocations([candidate({ rawLocation: 'Remote - Dallas' })]);
  assert.deepEqual(result.locationsV2, [{ kind: 'city', locationId: 'geonames:4684888' }]);
});



test('comma-separated ATS locations keep an unambiguous city outside the listed country', () => {
  const [result] = normalizeCandidateLocations([
    candidate({ rawLocation: 'Tallinn, Spain (Remote)' }),
  ]);
  assert.deepEqual(new Set(result.locationsV2.map((item) => item.locationId)), new Set([
    'geonames:588409',
    'iso3166:ES',
  ]));
  assert.equal(result.locationNormalization.unresolved.some(
    (item) => item.raw === 'Tallinn',
  ), false);
});

test('provider pseudo-city country scopes remain canonical v2 countries', () => {
  const [canada, germanyAndUk] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Canada Remote',
      locations: [{
        countryName: 'Canada', countryCode: 'CA', cityName: 'Canada Remote - Consultant use only', region: null,
      }],
    }),
    candidate({
      rawLocation: '2 Locations',
      detailRawLocation: 'Germany Remote; United Kingdom Remote',
      locations: [{
        countryName: 'Germany', countryCode: 'DE', cityName: 'Germany Remote', region: null,
      }],
    }),
  ]);
  assert.deepEqual(canada.locationsV2, [{ kind: 'country', locationId: 'iso3166:CA' }]);
  assert.deepEqual(new Set(germanyAndUk.locationsV2.map((item) => item.locationId)), new Set([
    'iso3166:DE',
    'iso3166:GB',
  ]));
});

test('description marketing language does not create a World geography claim', () => {
  const [travelPolicy, globalCulture, genericAnywhere] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Remote',
      description: 'Working while traveling to other countries requires approval under our Global Remote Travel Policy.',
    }),
    candidate({
      rawLocation: 'United Kingdom (Remote)',
      description: 'Why you will thrive: 100% Remote, Global Culture. We work with customers around the world.',
    }),
    candidate({
      rawLocation: 'Europe',
      description: 'Work From Anywhere: Fully remote. Choose the environment where you do your best work.',
    }),
  ]);
  assert.equal(travelPolicy.locationsV2.some((item) => item.locationId === 'm49:001'), false);
  assert.equal(globalCulture.locationsV2.some((item) => item.locationId === 'm49:001'), false);
  assert.equal(genericAnywhere.locationsV2.some((item) => item.locationId === 'm49:001'), false);
  assert.equal(genericAnywhere.locationsV2.some((item) => item.locationId === 'm49:150'), true);
});

test('explicit description worldwide scope still creates a World geography claim', () => {
  const [result] = normalizeCandidateLocations([candidate({
    rawLocation: 'Remote',
    description: 'Remote worldwide, with substantial Europe time-zone overlap.',
  })]);
  assert.equal(result.locationsV2.some((item) => item.locationId === 'm49:001'), true);
});

test('explicit Hybrid suffix can resolve a dominant standalone city', () => {
  const [result] = normalizeCandidateLocations([candidate({
    rawLocation: 'Mexico City - Hybrid',
    remoteType: 'Hybrid',
  })]);
  assert.deepEqual(result.locationsV2, [{ kind: 'city', locationId: 'geonames:3530597' }]);
});

test('broad named scopes use Locations v2 identities', () => {
  const [dach, emea, worldwide] = normalizeCandidateLocations([
    candidate({ rawLocation: 'DACH Remote' }),
    candidate({ rawLocation: 'EMEA Remote' }),
    candidate({ rawLocation: 'Remote worldwide' }),
  ]);
  assert.deepEqual(new Set(dach.locationsV2.map((item) => item.locationId)), new Set([
    'iso3166:DE', 'iso3166:AT', 'iso3166:CH',
  ]));
  assert.deepEqual(new Set(emea.locationsV2.map((item) => item.locationId)), new Set([
    'm49:150', 'm49:002', 'm49:145',
  ]));
  assert.deepEqual(worldwide.locationsV2, [{ kind: 'globalRegion', locationId: 'm49:001' }]);
});

test('EU and EEA scopes do not broaden to all of geographic Europe', () => {
  const [eu, eea] = normalizeCandidateLocations([
    candidate({ rawLocation: 'EU Remote' }),
    candidate({ rawLocation: 'EEA Remote' }),
  ]);
  const euIds = new Set(eu.locationsV2.map((item) => item.locationId));
  const eeaIds = new Set(eea.locationsV2.map((item) => item.locationId));
  assert.equal(euIds.has('iso3166:DE'), true);
  assert.equal(euIds.has('iso3166:GB'), false);
  assert.equal(euIds.has('iso3166:CH'), false);
  assert.equal(euIds.has('m49:150'), false);
  assert.equal(eeaIds.has('iso3166:NO'), true);
  assert.equal(eeaIds.has('iso3166:GB'), false);
  assert.equal(eeaIds.has('iso3166:CH'), false);
  assert.equal(eeaIds.has('m49:150'), false);
});

test('negative anywhere evidence does not create a global positive claim', () => {
  const [result] = normalizeCandidateLocations([
    candidate({ rawLocation: 'Work from anywhere except California' }),
  ]);
  assert.equal(result.locationsV2.some((item) => item.locationId === 'm49:001'), false);
});

test('explicit Eastern Time work hours stay separate from geography', () => {
  const [result] = normalizeCandidateLocations([candidate({
    rawLocation: 'Remote worldwide',
    description: 'You must work Eastern Time hours.',
  })]);
  assert.deepEqual(result.locationsV2, [{ kind: 'globalRegion', locationId: 'm49:001' }]);
  assert.deepEqual(result.workTimeConstraintsV2, [{
    offsetRangeStartMinutes: -300,
    offsetRangeEndMinutes: -240,
  }]);
});

test('ambiguous work-time terms are diagnostic only', () => {
  const [result] = normalizeCandidateLocations([candidate({
    description: 'You must work CST hours and overlap European working hours.',
  })]);
  assert.deepEqual(result.workTimeConstraintsV2, []);
  assert.ok(result.workTimeConstraints.observations.length > 0);
});

test('remote broad job scope can contain a narrower user selector', () => {
  const result = evaluateDiscoveryEligibility(
    candidate({ locationsV2: [{ kind: 'globalRegion', locationId: 'm49:150' }] }),
    user({
      includeLocations: [{ kind: 'country', locationId: 'iso3166:DE' }],
      excludeLocations: [], utcOffsetRanges: [], excludeWorkTimeRanges: [], allowUnknownLocation: false,
    }),
    { catalog },
  );
  assert.equal(result.allowed, true);
});

test('positive and negative selectors are evaluated on the same direct branch', () => {
  const berlin = { kind: 'city', locationId: 'geonames:2950159' };
  const munich = { kind: 'city', locationId: 'geonames:2867714' };
  const prefs = user({
    includeLocations: [{ kind: 'country', locationId: 'iso3166:DE' }],
    excludeLocations: [berlin], utcOffsetRanges: [], excludeWorkTimeRanges: [], allowUnknownLocation: false,
  });
  assert.equal(evaluateDiscoveryEligibility(candidate({ locationsV2: [berlin] }), prefs, { catalog }).allowed, false);
  assert.equal(evaluateDiscoveryEligibility(candidate({ locationsV2: [munich] }), prefs, { catalog }).allowed, true);
});

test('an enabled work arrangement with no geography rules accepts unknown geography', () => {
  const result = evaluateDiscoveryEligibility(
    candidate({ locationsV2: [] }),
    user({
      includeLocations: [],
      excludeLocations: [],
      utcOffsetRanges: [],
      excludeWorkTimeRanges: [],
      allowUnknownLocation: false,
    }),
    { catalog },
  );
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'no_geography_restriction');
});

test('UTC and work-time preference ranges are not discovery filters', () => {
  const result = evaluateDiscoveryEligibility(
    candidate({ locationsV2: [{ kind: 'country', locationId: 'iso3166:DE' }] }),
    user({
      includeLocations: [{ kind: 'country', locationId: 'iso3166:DE' }],
      excludeLocations: [],
      utcOffsetRanges: [{ startMinutes: -840, endMinutes: -840 }],
      excludeWorkTimeRanges: [{ startMinutes: -300, endMinutes: -240 }],
      allowUnknownLocation: false,
    }),
    { catalog },
  );
  assert.equal(result.allowed, true);
});

test('invalid stored selectors warn and do not abort the run', () => {
  const warnings = [];
  const result = evaluateDiscoveryEligibility(
    candidate({ locationsV2: [{ kind: 'country', locationId: 'iso3166:DE' }] }),
    user({
      includeLocations: [{ kind: 'country', locationId: 'iso3166:ZZ' }],
      excludeLocations: [], utcOffsetRanges: [], excludeWorkTimeRanges: [], allowUnknownLocation: false,
    }),
    { catalog, warnings },
  );
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'no_valid_positive_selector');
  assert.equal(warnings.length, 1);
});

test('geography filtering removes only users that do not match', () => {
  const userA = user({
    includeLocations: [{ kind: 'country', locationId: 'iso3166:DE' }],
    excludeLocations: [], utcOffsetRanges: [], excludeWorkTimeRanges: [], allowUnknownLocation: false,
  });
  const userB = {
    ...userA,
    userId: '22222222-2222-4222-8222-222222222222',
    discoveryPreferences: {
      ...userA.discoveryPreferences,
      eligibility: { remote: {
        includeLocations: [{ kind: 'country', locationId: 'iso3166:FR' }],
        excludeLocations: [], utcOffsetRanges: [], excludeWorkTimeRanges: [], allowUnknownLocation: false,
      } },
    },
  };
  const job = candidate({
    locationsV2: [{ kind: 'country', locationId: 'iso3166:DE' }],
    matchedUserIds: [userA.userId, userB.userId],
  });
  const result = applyDiscoveryEligibility([job], [userA, userB], { catalog });
  assert.deepEqual(result.candidates[0].matchedUserIds, [userA.userId]);
});

test('country-qualified Anywhere stays within that country', () => {
  const [inUs, commaUs, bareAnywhere] = normalizeCandidateLocations([
    candidate({ rawLocation: 'Anywhere in the United States' }),
    candidate({ rawLocation: 'Anywhere, USA' }),
    candidate({ rawLocation: 'Anywhere' }),
  ]);
  assert.deepEqual(inUs.locationsV2, [{ kind: 'country', locationId: 'iso3166:US' }]);
  assert.deepEqual(commaUs.locationsV2, [{ kind: 'country', locationId: 'iso3166:US' }]);
  assert.deepEqual(bareAnywhere.locationsV2, []);
  assert.equal(inUs.locationsV2.some((item) => item.locationId === 'm49:001'), false);
  assert.equal(commaUs.locationsV2.some((item) => item.locationId === 'm49:001'), false);
});

test('fully qualified city admin country forms emit canonical cities', () => {
  const [sanFrancisco, sunnyvale, munich, singapore] = normalizeCandidateLocations([
    candidate({ rawLocation: 'San Francisco, CA, United States', remoteType: 'On-Site' }),
    candidate({ rawLocation: 'Sunnyvale, CA, United States', remoteType: 'On-Site' }),
    candidate({ rawLocation: 'Munich, BY, Germany', remoteType: 'On-Site' }),
    candidate({ rawLocation: 'Singapore, Singapore', remoteType: 'On-Site' }),
  ]);
  assert.deepEqual(sanFrancisco.locationsV2, [{ kind: 'city', locationId: 'geonames:5391959' }]);
  assert.deepEqual(sunnyvale.locationsV2, [{ kind: 'city', locationId: 'geonames:5400075' }]);
  assert.deepEqual(munich.locationsV2, [{ kind: 'city', locationId: 'geonames:2867714' }]);
  assert.deepEqual(singapore.locationsV2, [{ kind: 'city', locationId: 'geonames:1880252' }]);
});

test('opaque provider city falls back to canonical structured geography', () => {
  const [result] = normalizeCandidateLocations([candidate({
    rawLocation: 'Oregon - Newberg Campus',
    remoteType: 'Hybrid',
    locations: [{
      countryName: 'United States of America',
      countryCode: 'US',
      cityName: 'Oregon - Newberg Campus',
      region: null,
    }],
  })]);
  assert.deepEqual(result.locationsV2, [{ kind: 'adminRegion', locationId: 'geonames:5744337' }]);
  assert.equal(result.locations[0].cityName, 'Oregon - Newberg Campus');
});

test('structured country fallback does not broaden a refined city claim', () => {
  const [result] = normalizeCandidateLocations([candidate({
    rawLocation: 'Palo Alto, CA',
    remoteType: 'On-Site',
    locations: [{
      countryName: 'United States',
      countryCode: 'US',
      cityName: 'Palo Alto Campus 42',
      region: null,
    }],
  })]);
  assert.deepEqual(result.locationsV2, [{ kind: 'city', locationId: 'geonames:5380748' }]);
});

test('boundary country parser does not collapse two explicit countries into one', () => {
  const [result] = normalizeCandidateLocations([candidate({
    rawLocation: 'Germany, Berlin, France',
    remoteType: 'On-Site',
  })]);
  assert.deepEqual(result.locationsV2, []);
});

test('US state abbreviations take precedence over colliding ISO country codes', () => {
  const [delaware, germany, multiState] = normalizeCandidateLocations([
    candidate({ rawLocation: 'Millsboro, DE', remoteType: 'On-Site' }),
    candidate({ rawLocation: 'Berlin, DE', remoteType: 'On-Site' }),
    candidate({ rawLocation: 'Buffalo, NY, Bridgeport, CT', remoteType: 'On-Site' }),
  ]);
  assert.deepEqual(delaware.locationsV2, [
    { kind: 'adminRegion', locationId: 'geonames:4142224' },
  ]);
  assert.deepEqual(germany.locationsV2, [
    { kind: 'city', locationId: 'geonames:2950159' },
  ]);
  assert.deepEqual(new Set(multiState.locationsV2.map((item) => item.locationId)), new Set([
    'geonames:5110629',
    'geonames:5282804',
  ]));
  assert.equal(delaware.locationsV2.some((item) => item.locationId === 'iso3166:DE'), false);
});

test('explicit comma-separated country alternatives remain separate v2 branches', () => {
  const [result] = normalizeCandidateLocations([candidate({
    rawLocation: 'Remote - Mexico, India, Brazil, Canada',
  })]);
  assert.deepEqual(new Set(result.locationsV2.map((item) => item.locationId)), new Set([
    'iso3166:MX',
    'iso3166:IN',
    'iso3166:BR',
    'iso3166:CA',
  ]));
});

test('India provider aliases recover Bengaluru from explicit qualified locations', () => {
  const [rawRemote, workdayRaw] = normalizeCandidateLocations([
    candidate({ rawLocation: 'Remote (India - Bangalore ONLY)' }),
    candidate({ rawLocation: 'IND, Karnataka, Bangalore' }),
  ]);
  assert.deepEqual(rawRemote.locationsV2, [
    { kind: 'city', locationId: 'geonames:1277333' },
  ]);
  assert.deepEqual(workdayRaw.locationsV2, [
    { kind: 'city', locationId: 'geonames:1277333' },
  ]);
});

test('restricted US state lists in explicit candidate scope remain state branches', () => {
  const [result, rawOnly] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Remote (United States - Select States)',
      description: 'This position is only available to candidates residing in the following U.S. states: FL, IL, MA, MO, OR, TX, and WA. Applications from other states will not be considered.',
    }),
    candidate({ rawLocation: 'Remote (United States - Select States)' }),
  ]);
  assert.deepEqual(new Set(result.locationsV2.map((item) => item.locationId)), new Set([
    'geonames:4155751',
    'geonames:4896861',
    'geonames:6254926',
    'geonames:4398678',
    'geonames:5744337',
    'geonames:4736286',
    'geonames:5815135',
  ]));
  assert.equal(result.locationsV2.some((item) => item.locationId === 'iso3166:US'), false);
  assert.deepEqual(rawOnly.locationsV2, []);
});

test('compensation state lists are not treated as candidate location restrictions', () => {
  const [result] = normalizeCandidateLocations([candidate({
    rawLocation: 'Remote',
    description: 'Compensation varies by U.S. states: CA, NY, TX, and WA. See the salary table for details.',
  })]);
  assert.deepEqual(result.locationsV2, []);
});

test('provider WFH country tokens recover explicit country alternatives', () => {
  const [result] = normalizeCandidateLocations([candidate({
    rawLocation: '6 Locations',
    detailRawLocation: 'Mannheim, Germany; NL_Netherlands_WFH; DE_Germany_WFH; ES_Spain_WFH; BE_Belgium_WFH; Pozuelo de Alarcón, Spain',
    remoteType: 'On-Site',
  })]);
  assert.deepEqual(new Set(result.locationsV2.map((item) => item.locationId)), new Set([
    'geonames:2873891',
    'iso3166:NL',
    'iso3166:DE',
    'iso3166:ES',
    'iso3166:BE',
    'geonames:3112989',
  ]));
});

test('qualified provider dash forms retain their narrowest deterministic geography', () => {
  const [fosterCity, oaks, pune] = normalizeCandidateLocations([
    candidate({ rawLocation: 'United States - California - Foster City', remoteType: 'On-Site' }),
    candidate({ rawLocation: 'USA - PA - Oaks', remoteType: 'On-Site' }),
    candidate({ rawLocation: 'IND-Pune-Equifax Analytics-PEC', remoteType: 'On-Site' }),
  ]);
  assert.deepEqual(fosterCity.locationsV2, [
    { kind: 'city', locationId: 'geonames:5350159' },
  ]);
  assert.deepEqual(oaks.locationsV2, [
    { kind: 'adminRegion', locationId: 'geonames:6254927' },
  ]);
  assert.deepEqual(pune.locationsV2, [
    { kind: 'city', locationId: 'geonames:1259229' },
  ]);
});

test('preliminary discovery geography ranks matches, unknowns, and mismatches without dropping users', () => {
  const germanyUser = user({
    includeLocations: [{ kind: 'country', locationId: 'iso3166:DE' }],
    excludeLocations: [],
    allowUnknownLocation: false,
  });
  const normalized = normalizeCandidateLocations([
    candidate({ rawLocation: 'Berlin, Germany' }),
    candidate({ rawLocation: 'Remote' }),
    candidate({ rawLocation: 'Toronto, Canada' }),
  ]);

  const result = annotatePreliminaryDiscoveryEligibility(normalized, [germanyUser]);

  assert.deepEqual(result.candidates.map((item) => item.preliminaryGeography.status), [
    'matched', 'unknown', 'mismatch',
  ]);
  assert.deepEqual(result.counts, { matched: 1, unknown: 1, mismatch: 1 });
  assert.deepEqual(result.candidates[2].matchedUserIds, [germanyUser.userId]);
});

test('population dominance resolves a standalone city only when one catalog candidate clearly dominates', () => {
  const [hamburg, london, springfield] = normalizeCandidateLocations([
    candidate({ rawLocation: 'Hamburg', remoteType: 'On-Site' }),
    candidate({ rawLocation: 'London', remoteType: 'On-Site' }),
    candidate({ rawLocation: 'Springfield', remoteType: 'On-Site' }),
  ]);
  assert.deepEqual(hamburg.locationsV2, [{ kind: 'city', locationId: 'geonames:2911298' }]);
  assert.deepEqual(london.locationsV2, [{ kind: 'city', locationId: 'geonames:2643743' }]);
  assert.deepEqual(springfield.locationsV2, []);
  assert.ok(springfield.locationNormalization.unresolved.length > 0);
});

test('population-only location inference cannot trigger early geography rejection', () => {
  const germanyUser = user({
    includeLocations: [{ kind: 'country', locationId: 'iso3166:DE' }],
    excludeLocations: [],
    allowUnknownLocation: false,
  });
  const [london] = annotatePreliminaryDiscoveryEligibility(
    normalizeCandidateLocations([candidate({ rawLocation: 'London', remoteType: 'On-Site' })]),
    [germanyUser],
  ).candidates;
  assert.equal(london.preliminaryGeography.status, 'mismatch');
  assert.equal(isDefinitePreliminaryGeographyMismatch(london), false);
});

test('generic two-letter codes resolve only when country and admin meanings are unambiguous', () => {
  const [turkey, texas, canada, germany] = normalizeCandidateLocations([
    candidate({ rawLocation: 'TR', remoteType: 'On-Site' }),
    candidate({ rawLocation: 'TX', remoteType: 'On-Site' }),
    candidate({ rawLocation: 'CA', remoteType: 'On-Site' }),
    candidate({ rawLocation: 'DE', remoteType: 'On-Site' }),
  ]);
  assert.deepEqual(turkey.locationsV2, [{ kind: 'country', locationId: 'iso3166:TR' }]);
  assert.deepEqual(texas.locationsV2, [{ kind: 'adminRegion', locationId: 'geonames:4736286' }]);
  assert.deepEqual(canada.locationsV2, []);
  assert.deepEqual(germany.locationsV2, []);
});

test('location fallback resolves unique alternate city names in the catalog', () => {
  const expected = [
    ['Lisboa', 'geonames:2267057'],
    ['Mailand', 'geonames:3173435'],
    ['Makati', 'geonames:1703417'],
  ];
  for (const [rawLocation, locationId] of expected) {
    const [result] = normalizeCandidateLocations([candidate({ rawLocation, remoteType: 'On-Site' })]);
    assert.deepEqual(result.locationsV2, [{ kind: 'city', locationId }], rawLocation);
  }
});

test('location fallback does not turn ambiguous text or opaque codes into unrelated geography', () => {
  const values = ['Bordon', 'Norwalk', '00', 'P6', 'VIC'];
  const normalized = normalizeCandidateLocations(values.map((rawLocation) => (
    candidate({ rawLocation, remoteType: 'On-Site' })
  )));
  for (const item of normalized) assert.deepEqual(item.locationsV2, [], item.rawLocation);
});

function fallbackRegressionCatalog() {
  return createLocationsV2Catalog({
    schemaVersion: 1,
    sourceSchemaVersion: 2,
    catalogVersion: 'fallback-regressions',
    referenceYear: 2026,
    regions: [],
    countries: [
      { id: 'iso3166:IN', kind: 'country', name: 'India', countryCode: 'IN', alpha3Code: 'IND', aliases: [] },
      { id: 'iso3166:RS', kind: 'country', name: 'Serbia', countryCode: 'RS', aliases: [] },
      { id: 'iso3166:TR', kind: 'country', name: 'Türkiye', countryCode: 'TR', aliases: ['Turkey'] },
      { id: 'iso3166:TW', kind: 'country', name: 'Taiwan', countryCode: 'TW', aliases: [] },
      { id: 'iso3166:IT', kind: 'country', name: 'Italy', countryCode: 'IT', aliases: [] },
    ],
    adminRegions: [{
      id: 'geonames:10097359', kind: 'adminRegion', name: 'Peć District', countryCode: 'RS',
      admin1Code: 'PEC', aliases: ['PEC'], ancestors: ['iso3166:RS'],
    }],
    cities: [
      { id: 'geonames:1259229', kind: 'city', name: 'Pune', countryCode: 'IN', population: 3100000, ancestors: ['iso3166:IN'] },
      { id: 'geonames:745044', kind: 'city', name: 'Istanbul', countryCode: 'TR', population: 15000000, ancestors: ['iso3166:TR'] },
      { id: 'geonames:1670909', kind: 'city', name: 'Bade District', countryCode: 'TW', population: 209148, aliases: ['Bade'], ancestors: ['iso3166:TW'] },
      { id: 'geonames:3173435', kind: 'city', name: 'Milan', countryCode: 'IT', population: 1371498, aliases: ['Mailand'], ancestors: ['iso3166:IT'] },
    ],
  });
}

test('unresolved provider site codes cannot become foreign administrative regions', () => {
  const catalogWithPec = fallbackRegressionCatalog();
  assert.equal(catalogWithPec.resolveStandalone('PEC')?.item.id, 'geonames:10097359');
  const [result] = normalizeCandidateLocations([
    candidate({ rawLocation: 'IND-Pune-Equifax Analytics-PEC', remoteType: 'On-Site' }),
  ], { v2Catalog: catalogWithPec });
  assert.deepEqual(result.locationsV2, [{ kind: 'city', locationId: 'geonames:1259229' }]);
  assert.ok(result.locationNormalization.unresolved.some((item) => item.raw === 'PEC'));
});

test('short district aliases need country context for standalone lookup', () => {
  const catalogWithBade = fallbackRegressionCatalog();
  assert.equal(catalogWithBade.resolveStandalone('Bade'), null);
  assert.equal(catalogWithBade.resolveCityGlobal('Bade'), null);
  assert.equal(catalogWithBade.resolveCity('Bade', 'TW')?.id, 'geonames:1670909');
  assert.equal(catalogWithBade.resolveStandalone('Bade District')?.item.id, 'geonames:1670909');
  assert.equal(catalogWithBade.resolveStandalone('Mailand')?.item.id, 'geonames:3173435');
});

test('country and foreign admin exact-name collisions stay unresolved without context', () => {
  const [georgia] = normalizeCandidateLocations([
    candidate({ rawLocation: 'Georgia', remoteType: 'On-Site' }),
  ]);
  assert.deepEqual(georgia.locationsV2, []);
  assert.ok(georgia.locationNormalization.unresolved.length > 0);
});

test('standalone admin names beat same-name cities but population-only city choices stay tentative', () => {
  const [england, ontario, london] = normalizeCandidateLocations([
    candidate({ rawLocation: 'England', remoteType: 'On-Site' }),
    candidate({ rawLocation: 'Ontario', remoteType: 'On-Site' }),
    candidate({ rawLocation: 'London', remoteType: 'On-Site' }),
  ]);
  assert.deepEqual(england.locationsV2, [{ kind: 'adminRegion', locationId: 'geonames:6269131' }]);
  assert.deepEqual(ontario.locationsV2, [{ kind: 'adminRegion', locationId: 'geonames:6093943' }]);
  assert.equal(
    london.locationNormalization.observations.find((item) => item.kind === 'catalog_resolution')?.confidence,
    'tentative',
  );
});

test('catalog resolves alpha-3 country codes and data-supplied city alternate names', () => {
  const synthetic = createLocationsV2Catalog({
    schemaVersion: 1,
    sourceSchemaVersion: 2,
    catalogVersion: 'test',
    referenceYear: 2026,
    regions: [],
    countries: [{
      id: 'iso3166:PT', kind: 'country', name: 'Portugal', countryCode: 'PT', alpha3Code: 'PRT',
      aliases: [], ancestors: [],
    }],
    adminRegions: [],
    cities: [{
      id: 'geonames:2267057', kind: 'city', name: 'Lisbon', countryCode: 'PT',
      aliases: ['Lisboa'], population: 517802, ancestors: ['iso3166:PT'],
    }],
  });
  assert.equal(synthetic.resolveCountryCode('PRT')?.id, 'iso3166:PT');
  assert.deepEqual(synthetic.resolveStandalone('Lisboa'), {
    item: synthetic.get('city', 'geonames:2267057'),
    method: 'exact_unique_city',
    confidence: 'high',
  });
});

test('country-qualified fallback keeps the city, not its country ancestor', () => {
  const [result] = normalizeCandidateLocations([
    candidate({ rawLocation: 'Istanbul, Turkey, On-Site', remoteType: 'On-Site' }),
  ], { v2Catalog: fallbackRegressionCatalog() });
  assert.deepEqual(result.locationsV2, [{ kind: 'city', locationId: 'geonames:745044' }]);
  assert.equal(result.locationNormalization.status, 'catalog_resolved');
  assert.deepEqual(result.locationNormalization.unresolved, []);
});

test('repeated qualified fallback entries do not remove the location', () => {
  const [result] = normalizeCandidateLocations([
    candidate({ rawLocation: 'Turkey, Turkey', remoteType: 'On-Site' }),
  ], { v2Catalog: fallbackRegressionCatalog() });
  assert.deepEqual(result.locationsV2, [{ kind: 'country', locationId: 'iso3166:TR' }]);
});

test('partially resolvable comma geography keeps unresolved evidence', () => {
  const [result] = normalizeCandidateLocations([
    candidate({ rawLocation: 'Istanbul, Unknownshire, On-Site', remoteType: 'On-Site' }),
  ]);
  assert.deepEqual(result.locationsV2, [{ kind: 'city', locationId: 'geonames:745044' }]);
  assert.equal(result.locationNormalization.status, 'partially_resolved');
  assert.ok(result.locationNormalization.unresolved.length > 0);
  assert.equal(
    result.locationNormalization.observations.find((item) => item.kind === 'catalog_resolution')?.confidence,
    'high',
  );
});

test('work-time parenthetical does not prevent an explicit country from resolving', () => {
  const [result] = normalizeCandidateLocations([
    candidate({ rawLocation: 'USA (EST and CST) - Remote', remoteType: 'Remote' }),
  ]);
  assert.deepEqual(result.locationsV2, [{ kind: 'country', locationId: 'iso3166:US' }]);
  assert.deepEqual(result.locationNormalization.unresolved, []);
});

test('safe location suffix cleanup keeps geography and removes non-geographic qualifiers', () => {
  const [london, paloAlto] = normalizeCandidateLocations([
    candidate({ rawLocation: 'London, United Kingdom - Deliveroo', remoteType: 'On-Site' }),
    candidate({ rawLocation: 'Palo Alto, California, United States (or nearby)', remoteType: 'On-Site' }),
  ]);
  assert.deepEqual(london.locationsV2, [{ kind: 'city', locationId: 'geonames:2643743' }]);
  assert.deepEqual(paloAlto.locationsV2, [{ kind: 'city', locationId: 'geonames:5380748' }]);
});

test('explicit remote region scope is retained without a user location filter', () => {
  const [europe, latam, africa] = normalizeCandidateLocations([
    candidate({ rawLocation: 'Remote', description: 'Location: Remote from within Europe.' }),
    candidate({ rawLocation: 'Remote', description: 'Location: LATAM 100% Remote.' }),
    candidate({ rawLocation: 'Remote', description: 'Candidates must be located within Africa.' }),
  ]);
  assert.deepEqual(europe.locationsV2, [{ kind: 'globalRegion', locationId: 'm49:150' }]);
  assert.deepEqual(latam.locationsV2, [{ kind: 'globalRegion', locationId: 'm49:419' }]);
  assert.deepEqual(africa.locationsV2, [{ kind: 'globalRegion', locationId: 'm49:002' }]);
  assert.deepEqual(europe.locationNormalization.unresolved, []);
});

test('definite preliminary rejection is limited to resolved non-remote single-branch mismatches', () => {
  const base = {
    remoteType: 'On-Site',
    locationsV2: [{ kind: 'city', locationId: 'geonames:6167865' }],
    locationNormalization: { consistency: 'consistent', unresolved: [] },
    preliminaryGeography: { status: 'mismatch' },
    userMatch: {
      preliminaryGeography: [{ userId: 'u1', allowed: false, reason: 'no_matching_location_branch' }],
    },
  };
  assert.equal(isDefinitePreliminaryGeographyMismatch(base), true);
  assert.equal(isDefinitePreliminaryGeographyMismatch({ ...base, remoteType: 'Remote' }), false);
  assert.equal(isDefinitePreliminaryGeographyMismatch({
    ...base,
    locationsV2: [...base.locationsV2, { kind: 'country', locationId: 'iso3166:CA' }],
  }), false);
  assert.equal(isDefinitePreliminaryGeographyMismatch({
    ...base,
    locationNormalization: { consistency: 'consistent', unresolved: [{ raw: 'unknown' }] },
  }), false);
});

test('APAC resolves to Asia and Oceania and never to Apac in Uganda', () => {
  const [item] = normalizeCandidateLocations([
    candidate({ rawLocation: 'APAC, Remote, On-Site', remoteType: 'On-Site' }),
  ]);
  assert.ok(item.locationsV2.some((location) => location.locationId === 'm49:142'));
  assert.ok(item.locationsV2.some((location) => location.locationId === 'm49:009'));
  assert.ok(!item.locationsV2.some((location) => location.locationId === 'geonames:235130'));
});

test('canonical Cambridge beats an alias from Newton in the same region', () => {
  const sample = createLocationsV2Catalog({
    schemaVersion: 1,
    regions: [],
    countries: [{ id: 'iso3166:US', kind: 'country', name: 'United States', countryCode: 'US' }],
    adminRegions: [{ id: 'admin:MA', kind: 'adminRegion', name: 'Massachusetts', countryCode: 'US', admin1Code: 'MA' }],
    cities: [
      { id: 'city:cambridge', kind: 'city', name: 'Cambridge', countryCode: 'US', admin1Id: 'admin:MA', population: 120000, aliases: [] },
      { id: 'city:newton', kind: 'city', name: 'Newton', countryCode: 'US', admin1Id: 'admin:MA', population: 90000, aliases: ['Cambridge'] },
    ],
  });
  assert.equal(sample.resolveCity('Cambridge', 'US', { adminRegion: 'MA' })?.id, 'city:cambridge');
  assert.equal(sample.resolveCity('Newton', 'US')?.id, 'city:newton');
});

test('the actual city Apac in Uganda is not a business region', () => {
  const [item] = normalizeCandidateLocations([
    candidate({ rawLocation: 'Apac, Uganda', remoteType: 'On-Site' }),
  ]);
  assert.ok(!item.locationsV2.some((location) => ['m49:142', 'm49:009'].includes(location.locationId)));
});

test('run1023 DACH customer region does not create German-speaking job locations', () => {
  const [item] = normalizeCandidateLocations([candidate({
    rawLocation: 'Sydney NSW, AU, 2000',
    locations: [{ countryName: 'Australia', countryCode: 'AU', cityName: 'Sydney' }],
    remoteType: 'On-Site',
    description: 'This role is based in our Sydney office. A large share of customers is in the DACH region, and another engineering team is based in Germany.',
  })]);
  const ids = new Set(item.locationsV2.map((claim) => claim.locationId));
  assert.ok(ids.has('geonames:2147714') || ids.has('iso3166:AU'));
  for (const country of ['DE', 'AT', 'CH']) {
    assert.ok(!ids.has(`iso3166:${country}`), country);
  }
  assert.ok(item.locationNormalization.claimEvidence.every((entry) => ids.has(entry.locationId)));
});

test('run1023 EU remote working benefit does not add 27 eligibility countries', () => {
  const [item] = normalizeCandidateLocations([candidate({
    rawLocation: 'Görlitz',
    remoteType: 'On-Site',
    description: 'Benefits: EU Remote Working. Your office is in Görlitz.',
  })]);
  assert.deepEqual(item.locationsV2, [{ kind: 'city', locationId: 'geonames:2918987' }]);
});

test('an explicit regional candidate eligibility statement remains a scope', () => {
  const [item] = normalizeCandidateLocations([candidate({
    rawLocation: 'Remote',
    description: 'Candidates must be based in the DACH region.',
  })]);
  for (const code of ['DE', 'AT', 'CH']) {
    assert.ok(item.locationsV2.some((claim) => claim.locationId === `iso3166:${code}`));
  }
  assert.ok(item.locationNormalization.claimEvidence.some((entry) => (
    entry.sourceField === 'description' && entry.evidenceType === 'description_scope'
  )));
});

test('run1023 MEX MX code does not resolve Mex Switzerland', () => {
  const [item] = normalizeCandidateLocations([candidate({
    rawLocation: 'Remote', detailRawLocation: 'Remote, MEX, MX',
    remoteType: 'Remote',
  })]);
  assert.deepEqual(item.locationsV2, [{ kind: 'country', locationId: 'iso3166:MX' }]);
  assert.ok(!item.locationNormalization.claimEvidence.some((entry) => entry.locationId === 'geonames:2659668'));
});

test('country-qualified locations and separate city lists retain valid cities', () => {
  const [local, mixed] = normalizeCandidateLocations([
    candidate({ rawLocation: 'London, Canada', remoteType: 'On-Site' }),
    candidate({ rawLocation: 'Tallinn, Spain', remoteType: 'On-Site' }),
  ]);
  assert.ok(local.locationsV2.every((entry) => entry.locationId !== 'geonames:2643743'));
  assert.ok(mixed.locationsV2.some((entry) => entry.locationId === 'geonames:588409'));
});

test('Taiwan city from data-backed catalog resolves structured country and city', () => {
  const taiwanCatalog = createLocationsV2Catalog({
    schemaVersion: 1, catalogVersion: 'taiwan-fixture', referenceYear: 2026,
    regions: [{ id: 'm49:001', kind: 'globalRegion', name: 'World' }],
    countries: [{ id: 'iso3166:TW', kind: 'country', name: 'Taiwan', countryCode: 'TW',
      alpha3Code: 'TWN', ancestors: ['m49:001'] }],
    adminRegions: [],
    cities: [{ id: 'geonames:1668341', kind: 'city', name: 'Taipei', countryCode: 'TW',
      population: 2400000, ancestors: ['iso3166:TW', 'm49:001'] }],
  });
  const [item] = normalizeCandidateLocations([candidate({
    rawLocation: 'Taipei, TAIWAN, Taiwan, Remote',
    locations: [{ countryName: 'Taiwan', countryCode: 'TW', cityName: 'Taipei', region: null }],
  })], { v2Catalog: taiwanCatalog });
  assert.deepEqual(item.locationsV2, [{ kind: 'city', locationId: 'geonames:1668341' }]);
  assert.equal(item.locationNormalization.claimEvidence[0].sourceField, 'provider_structured');
});

test('location claim evidence names the matched provider field and rule', () => {
  const [item] = normalizeCandidateLocations([candidate({ rawLocation: 'Remote DACH' })]);
  assert.ok(item.locationNormalization.claimEvidence.length >= 3);
  assert.ok(item.locationNormalization.claimEvidence.every((entry) => (
    entry.sourceField === 'raw_location' && entry.rule === 'explicit_provider_broad_scope'
  )));
});

test('authorization-only description does not create a job country', () => {
  const raw = candidate({
    rawLocation: 'Remote',
    description: 'Applicants must have authorization to work in the United States without sponsorship. Benefits include 401(k).',
    applicationQuestions: [{ label: 'Are you legally authorized to work in the United States?', required: true, countryHint: 'US', kind: 'work_authorization' }],
  });
  const [current] = normalizeCandidateLocations([raw]);
  const [baseline] = normalizeCandidateLocations([raw], { locationPolicy: 'baseline' });
  assert.deepEqual(current.locationsV2, []);
  assert.ok(baseline.locationsV2.some((claim) => claim.locationId === 'iso3166:US'));
  assert.equal(current.locationEligibility.applicationQuestionSignals.length, 1);
});

test('candidate hiring area remains geography without work authorization inference', () => {
  const [result] = normalizeCandidateLocations([candidate({
    rawLocation: 'Remote',
    description: 'Candidates must be based in Germany.',
  })]);
  assert.ok(result.locationsV2.some((claim) => claim.locationId === 'iso3166:DE'));
});
