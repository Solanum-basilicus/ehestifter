import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeCandidateLocations,
  normalizeRawLocation,
} from '../src/locations/normalizer.mjs';

const locationScopeFilter = {
  allow: [
    'Germany',
    'Deutschland',
    'Europe',
    'European Union',
    'EU',
    'EEA',
    'EMEA',
    'DACH',
    'Worldwide',
    'Anywhere',
    'Global',
  ],
  block: [
    'United States',
    'USA',
    'U.S.',
    'North America',
    'Canada',
    'France',
  ],
  restriction_markers: [
    'only',
    'based',
    'resident',
    'residents',
    'reside',
    'located',
    'must be',
    'must reside',
    'candidates in',
    'remote from',
    'remote in',
    'work authorization',
    'work authorisation',
    'right to work',
  ],
};

function candidate(overrides = {}) {
  return {
    rawLocation: null,
    locations: [],
    remoteType: 'Unknown',
    description: '',
    preflight: { status: 'ok', exists: false },
    ...overrides,
  };
}

test('normalizes canonical country aliases and provider colon forms', () => {
  assert.deepEqual(normalizeRawLocation('USA: Washington').locations, [
    {
      countryName: 'United States',
      countryCode: 'US',
      cityName: 'Washington',
      region: null,
    },
  ]);
  assert.deepEqual(normalizeRawLocation('DE: Berlin').locations, [
    {
      countryName: 'Germany',
      countryCode: 'DE',
      cityName: 'Berlin',
      region: null,
    },
  ]);
  assert.deepEqual(normalizeRawLocation('Remote, Deutschland').locations, [
    {
      countryName: 'Germany',
      countryCode: 'DE',
      cityName: null,
      region: null,
    },
  ]);
});

test('normalizes multiple concrete locations without treating scope words as cities', () => {
  const result = normalizeRawLocation('Berlin · Munich, Germany');
  assert.equal(result.status, 'normalized_multiple');
  assert.deepEqual(result.locations, [
    {
      countryName: 'Germany',
      countryCode: 'DE',
      cityName: 'Berlin',
      region: null,
    },
    {
      countryName: 'Germany',
      countryCode: 'DE',
      cityName: 'Munich',
      region: null,
    },
  ]);
  assert.deepEqual(result.unresolved, []);
});


test('normalizes multiple cities from provider code format and arrangement suffix', () => {
  const result = normalizeRawLocation('DE: Hechingen, Rastatt · On-Site');
  assert.equal(result.status, 'normalized_multiple');
  assert.deepEqual(result.locations, [
    {
      countryName: 'Germany',
      countryCode: 'DE',
      cityName: 'Hechingen',
      region: null,
    },
    {
      countryName: 'Germany',
      countryCode: 'DE',
      cityName: 'Rastatt',
      region: null,
    },
  ]);
  assert.deepEqual(result.unresolved, []);
});

test('provider structured locations are canonicalized instead of trusted verbatim', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Remote, Germany',
      remoteType: 'Remote',
      locations: [
        {
          countryName: 'Deutschland',
          countryCode: null,
          cityName: 'berlin',
          region: 'Berlin-Brandenburg',
        },
      ],
    }),
  ], { locationScopeFilter });

  assert.equal(result.locationNormalization.status, 'provider_structured');
  assert.deepEqual(result.locations, [
    {
      countryName: 'Germany',
      countryCode: 'DE',
      cityName: 'Berlin',
      region: 'Berlin-Brandenburg',
    },
  ]);
});


test('raw provider location can refine a structured country location', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Germany: Berlin',
      locations: [{
        countryName: 'Germany',
        countryCode: 'DE',
        cityName: null,
        region: null,
      }],
    }),
  ], { locationScopeFilter });

  assert.deepEqual(result.locations, [{
    countryName: 'Germany',
    countryCode: 'DE',
    cityName: 'Berlin',
    region: null,
  }]);
  assert.equal(result.locationNormalization.consistency, 'refined');
  assert.ok(result.locationNormalization.observations.some(
    (item) => item.source === 'provider_structured',
  ));
  assert.ok(result.locationNormalization.observations.some(
    (item) => item.source === 'raw_location',
  ));
});

test('structured and raw provider conflicts remain visible and fail open', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Remote Germany',
      remoteType: 'Remote',
      locations: [{
        countryName: 'United States',
        countryCode: 'US',
        cityName: null,
        region: null,
      }],
    }),
  ], { locationScopeFilter });

  assert.equal(result.locationNormalization.consistency, 'conflicting');
  assert.equal(result.locationEligibility.status, 'unclear');
  assert.deepEqual(result.locations.map((item) => item.countryCode).sort(), ['DE', 'US']);
});

test('does not infer a country from an unqualified city', () => {
  const result = normalizeRawLocation('Berlin');
  assert.equal(result.status, 'unparsed_single_value');
  assert.deepEqual(result.locations, []);
});

test('description refines a provider country with a mandatory HQ city', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Germany',
      remoteType: 'Hybrid',
      description: 'Required once-a-week presence in our Garching HQ.',
    }),
  ], { locationScopeFilter });

  assert.deepEqual(result.locations, [
    {
      countryName: 'Germany',
      countryCode: 'DE',
      cityName: 'Garching',
      region: null,
    },
  ]);
  assert.equal(result.locationNormalization.consistency, 'refined');
  assert.equal(result.locationEligibility.status, 'eligible');
  assert.ok(result.locationNormalization.observations.some(
    (item) => item.source === 'raw_location',
  ));
  assert.ok(result.locationNormalization.observations.some(
    (item) => item.source === 'description',
  ));
});

test('description clarifies unqualified Remote as US-only and rejects it', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Remote',
      remoteType: 'Remote',
      description: 'This role is open to candidates anywhere in the US only.',
    }),
  ], { locationScopeFilter });

  assert.equal(result.locationEligibility.status, 'ineligible');
  assert.equal(result.locationEligibility.reason, 'restriction_scope');
  assert.deepEqual(result.locations, [{
    countryName: 'United States',
    countryCode: 'US',
    cityName: null,
    region: null,
  }]);
});

test('mandatory incompatible office presence wins over broad compatible scope', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'EU Remote',
      remoteType: 'Remote',
      description: 'Employees must work three days per week from our Washington, United States office.',
    }),
  ], { locationScopeFilter });

  assert.equal(result.locationNormalization.consistency, 'conflicting');
  assert.equal(result.locationEligibility.status, 'ineligible');
  assert.equal(
    result.locationEligibility.reason,
    'mandatory_incompatible_office_presence',
  );
});


test('unresolved mandatory office clarification propagates as unclear', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'EU Remote',
      remoteType: 'Remote',
      description: 'Employees are expected three days a week in our Washington office.',
    }),
  ], { locationScopeFilter });

  assert.equal(result.locationEligibility.status, 'unclear');
  assert.equal(
    result.locationEligibility.reason,
    'mandatory_presence_location_unresolved',
  );
  assert.ok(result.locationEligibility.evidence.some(
    (item) => item.kind === 'mandatory_presence_unresolved',
  ));
});

test('non-restrictive foreign references do not override or reject provider scope', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'EU Remote',
      remoteType: 'Remote',
      description: 'You will support customers in the United States and Canada.',
    }),
  ], { locationScopeFilter });

  assert.equal(result.locationEligibility.status, 'eligible');
  assert.equal(result.locationNormalization.consistency, 'consistent');
});

test('unresolved and inconclusive conflicts fail open', () => {
  const [unresolved] = normalizeCandidateLocations([
    candidate({ rawLocation: 'Somewhere near the mountains' }),
  ], { locationScopeFilter });
  assert.equal(unresolved.locationEligibility.status, 'unclear');
  assert.deepEqual(unresolved.locations, []);

  const [conflict] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'EU Remote',
      remoteType: 'Remote',
      description: 'Our Washington office works closely with this team.',
    }),
  ], { locationScopeFilter });
  assert.notEqual(conflict.locationEligibility.status, 'ineligible');
});


test('company geography mentions do not become candidate restrictions', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Remote Europe',
      remoteType: 'Remote',
      description: 'Our company is based in the United States and serves global customers.',
    }),
  ], { locationScopeFilter });

  assert.equal(result.locationEligibility.status, 'eligible');
  assert.deepEqual(result.locations, []);
  assert.ok(!result.locationEligibility.evidence.some(
    (item) => item.disposition === 'incompatible',
  ));
});


test('negated US authorization requirement does not reject', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Remote Europe',
      remoteType: 'Remote',
      description: 'US work authorization is not required for this role.',
    }),
  ], { locationScopeFilter });
  assert.equal(result.locationEligibility.status, 'eligible');
  assert.ok(!result.locationEligibility.evidence.some(
    (item) => item.disposition === 'incompatible',
  ));
});

test('provider location explicitly excluding Germany rejects', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Remote Europe, excluding Germany',
      remoteType: 'Remote',
    }),
  ], { locationScopeFilter });
  assert.equal(result.locationEligibility.status, 'ineligible');
  assert.equal(result.locationEligibility.reason, 'explicit_exclusion');
});

test('nested Anywhere in a blocked scope does not override that scope', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Anywhere in the United States',
      remoteType: 'Remote',
    }),
  ], { locationScopeFilter });
  assert.equal(result.locationEligibility.status, 'ineligible');
});

test('existing jobs are observed but never retroactively gated', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Remote',
      description: 'US residents only.',
      preflight: { status: 'ok', exists: true },
    }),
  ], { locationScopeFilter });
  assert.equal(result.locationEligibility.status, 'not_applicable_existing');
});

test('HTML block boundaries preserve restrictive description clauses', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Remote',
      remoteType: 'Remote',
      description: '<ul><li>Join a distributed product team.</li><li>Candidates must reside in the United States.</li></ul>',
    }),
  ], { locationScopeFilter });
  assert.equal(result.locationEligibility.status, 'ineligible');
  assert.equal(result.locationEligibility.reason, 'restriction_scope');
});

test('boundary-safe aliases catch US-based restrictions', () => {
  const [based] = normalizeCandidateLocations([
    candidate({ rawLocation: 'Remote', description: 'US-based candidates only.' }),
  ], { locationScopeFilter });
  assert.equal(based.locationEligibility.status, 'ineligible');

  const [authorization] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Remote Europe',
      description: 'Applicants must have authorization to work in the US.',
    }),
  ], { locationScopeFilter });
  assert.equal(authorization.locationEligibility.status, 'ineligible');
});

test('bare US alias matching does not match Australia substrings', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Remote Europe',
      description: 'The team collaborates with colleagues in Australia.',
    }),
  ], { locationScopeFilter });
  assert.equal(result.locationEligibility.status, 'eligible');
});

test('disabled scope filter never blocks import eligibility', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Remote',
      description: 'US-based candidates only.',
    }),
  ], { locationScopeFilter: { ...locationScopeFilter, enabled: false } });
  assert.equal(result.locationEligibility.status, 'unclear');
  assert.equal(result.locationEligibility.reason, 'location_scope_filter_disabled');
});

test('citizenship still refines geography when eligibility filtering is disabled', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Remote',
      description: 'This opportunity is available to US citizens only.',
    }),
  ], { locationScopeFilter: { ...locationScopeFilter, enabled: false } });

  assert.deepEqual(result.locations, [{
    countryName: 'United States',
    countryCode: 'US',
    cityName: null,
    region: null,
  }]);
  assert.equal(result.locationEligibility.status, 'unclear');
});

test('US-based team references are not candidate restrictions', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Remote Europe',
      description: 'You will collaborate with US-based engineering teams.',
    }),
  ], { locationScopeFilter });
  assert.equal(result.locationEligibility.status, 'eligible');
  assert.ok(!result.locationEligibility.evidence.some(
    (item) => item.disposition === 'incompatible',
  ));
});

test('standalone based-in location declarations are decisive', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Remote Europe',
      description: 'Based in the United States.',
    }),
  ], { locationScopeFilter });
  assert.equal(result.locationEligibility.status, 'ineligible');
});

test('only and based wording about collaborators does not reject', () => {
  const results = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Remote Europe',
      description: 'Your role will only interact with US customers.',
    }),
    candidate({
      rawLocation: 'Remote Europe',
      description: 'This role works with a US-based engineering team.',
    }),
    candidate({
      rawLocation: 'Remote Europe',
      description: 'Candidates only work with US partner teams.',
    }),
  ], { locationScopeFilter });
  assert.deepEqual(
    results.map((item) => item.locationEligibility.status),
    ['eligible', 'eligible', 'eligible'],
  );
});

test('US administrative regions refine provider metadata without discarding arrangement', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Remote/Hybrid if local to Maryland',
      remoteType: 'Hybrid',
    }),
  ], { locationScopeFilter });

  assert.equal(result.remoteType, 'Hybrid');
  assert.deepEqual(result.locations, [{
    countryName: 'United States',
    countryCode: 'US',
    cityName: null,
    region: 'Maryland',
  }]);
  assert.equal(result.locationEligibility.status, 'ineligible');
  assert.ok(result.locationNormalization.observations.some(
    (item) => item.kind === 'region_country' && item.source === 'raw_location',
  ));
});

test('city and US state abbreviation resolve together from a location declaration', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Remote',
      description: 'Location: Austin, TX',
    }),
  ], { locationScopeFilter });

  assert.deepEqual(result.locations, [{
    countryName: 'United States',
    countryCode: 'US',
    cityName: 'Austin',
    region: 'Texas',
  }]);
  assert.equal(result.locationEligibility.status, 'ineligible');
});

test('city-only provider metadata is refined by strong employer country evidence', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Berlin',
      description: 'We are smava, one of the biggest FinTech companies in Germany.',
    }),
  ], { locationScopeFilter });

  assert.deepEqual(result.locations, [{
    countryName: 'Germany',
    countryCode: 'DE',
    cityName: 'Berlin',
    region: null,
  }]);
  assert.equal(result.locationNormalization.consistency, 'refined');
  assert.equal(result.locationEligibility.status, 'eligible');
  assert.ok(result.locationNormalization.observations.some(
    (item) => item.kind === 'provider_city_with_description_country_hint',
  ));
});

test('US citizenship restriction clarifies naked Remote scope', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Remote',
      remoteType: 'Remote',
      description: 'We are able to offer this opportunity only to US citizens.',
    }),
  ], { locationScopeFilter });

  assert.deepEqual(result.locations, [{
    countryName: 'United States',
    countryCode: 'US',
    cityName: null,
    region: null,
  }]);
  assert.equal(result.locationEligibility.status, 'ineligible');
  assert.equal(result.locationEligibility.reason, 'citizenship_scope');
});

test('high-signal US employment evidence disambiguates St. Petersburg', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'St. Petersburg',
      description: 'Benefits include medical insurance and a company 401(k) match.',
    }),
  ], { locationScopeFilter });

  assert.deepEqual(result.locations, [{
    countryName: 'United States',
    countryCode: 'US',
    cityName: 'St. Petersburg',
    region: null,
  }]);
});

test('US employment evidence disambiguates Georgia as a state', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Georgia',
      description: 'Benefits include health insurance and a company 401(k) match.',
    }),
  ], { locationScopeFilter });

  assert.deepEqual(result.locations, [{
    countryName: 'United States',
    countryCode: 'US',
    cityName: null,
    region: 'Georgia',
  }]);
});

test('required Pacific Time work hours are retained as future filter evidence', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      rawLocation: 'Remote',
      description: 'You must be available during Pacific Time working hours.',
    }),
  ], { locationScopeFilter });

  assert.equal(result.workTimeConstraints.status, 'resolved');
  assert.deepEqual(result.workTimeConstraints.regions, ['north_america_west']);
  assert.equal(result.workTimeConstraints.observations[0].strength, 'required');
});

test('German district qualifiers resolve into scanner-owned regions', () => {
  const result = normalizeRawLocation('Landkreis München');
  assert.deepEqual(result.locations, [{
    countryName: 'Germany',
    countryCode: 'DE',
    cityName: null,
    region: 'Landkreis München',
  }]);
});

test('bare PT is recorded only when a work-hours context is present', () => {
  const [required] = normalizeCandidateLocations([
    candidate({
      description: 'The role requires you to be active in PT timezone work hours.',
    }),
  ], { locationScopeFilter });
  assert.deepEqual(required.workTimeConstraints.regions, ['north_america_west']);

  const [unrelated] = normalizeCandidateLocations([
    candidate({ description: 'This is a PT product management position.' }),
  ], { locationScopeFilter });
  assert.equal(unrelated.workTimeConstraints.status, 'none');
});
