import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeCandidateLocations,
  normalizeRawLocation,
} from '../src/locations/normalizer.mjs';

test('normalizes an exact city and country pair', () => {
  const result = normalizeRawLocation(
    'Munich, Germany',
  );

  assert.equal(
    result.status,
    'normalized_city_country',
  );

  assert.deepEqual(result.locations, [
    {
      countryName: 'Germany',
      countryCode: 'DE',
      cityName: 'Munich',
      region: null,
    },
  ]);
});

test('normalizes a German country scope without inventing a city', () => {
  const result = normalizeRawLocation(
    'Remote, Germany',
  );

  assert.equal(
    result.status,
    'normalized_country_scope',
  );

  assert.deepEqual(result.locations, [
    {
      countryName: 'Germany',
      countryCode: 'DE',
      cityName: null,
      region: null,
    },
  ]);
});

test('rejects ambiguous multi-location text', () => {
  const result = normalizeRawLocation(
    'Berlin Office · Bosnia · Romania · Germany',
  );

  assert.equal(
    result.status,
    'unparsed_multiple',
  );

  assert.deepEqual(result.locations, []);
});

test('provider structured locations take precedence', () => {
  const [result] = normalizeCandidateLocations([
    {
      rawLocation: 'Remote, Germany',
      locations: [
        {
          countryName: 'Germany',
          countryCode: null,
          cityName: 'Berlin',
          region: 'Berlin-Brandenburg',
        },
      ],
    },
  ]);

  assert.equal(
    result.locationNormalization.status,
    'provider_structured',
  );

  assert.deepEqual(result.locations, [
    {
      countryName: 'Germany',
      countryCode: null,
      cityName: 'Berlin',
      region: 'Berlin-Brandenburg',
    },
  ]);
});

test('does not infer country from a city alone', () => {
  const result = normalizeRawLocation('Berlin');

  assert.equal(
    result.status,
    'unparsed_single_value',
  );

  assert.deepEqual(result.locations, []);
});
