import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeCandidateLocations } from '../src/locations/normalizer.mjs';
import {
  applyDiscoveryEligibility,
  evaluateDiscoveryEligibility,
} from '../src/locations/discovery-eligibility.mjs';
import { getDefaultLocationsV2Catalog } from '../src/locations/locations-v2-catalog.mjs';

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
