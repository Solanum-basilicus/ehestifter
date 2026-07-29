import test from 'node:test';
import assert from 'node:assert/strict';

import { createGeoDictionary } from '../src/locations/geo-dictionary.mjs';
import { normalizeCandidateLocations } from '../src/locations/normalizer.mjs';

const dictionary = createGeoDictionary({
  schemaVersion: 1,
  countries: [
    { name: 'Finland', code: 'FI', priority: false },
    { name: 'Germany', code: 'DE', priority: false },
    { name: 'United Kingdom', code: 'GB', priority: false },
  ],
  cities: { FI: [], DE: [], GB: [] },
});

const locationScopeFilter = {
  enabled: true,
  allow: ['Germany', 'Europe', 'EU', 'EEA', 'EMEA'],
  block: ['Finland', 'United Kingdom'],
  restriction_markers: ['only', 'based', 'resident', 'remote in'],
};

function candidate(overrides = {}) {
  return {
    title: 'Engineering Manager',
    rawLocation: 'Finland · Germany · United Kingdom',
    locations: [],
    remoteType: 'Unknown',
    description: '',
    preflight: { status: 'ok', exists: false },
    ...overrides,
  };
}

const mapboxDescription = `
Employment Requirements

Employment Type: Full-time

Weekly Hours: Full-time

Location/Hybrid Policy: Remote

By applying for this position, you acknowledge that you have received the Mapbox Non-US Privacy Notice for applicants.

#LI-Remote
`;

test('explicit Mapbox description policy supplies Remote as the final fallback', () => {
  const [result] = normalizeCandidateLocations([
    candidate({ description: mapboxDescription }),
  ], { dictionary, locationScopeFilter });

  assert.equal(result.remoteType, 'Remote');
  assert.deepEqual(
    result.locations.map((item) => item.countryCode),
    ['FI', 'DE', 'GB'],
  );
  assert.ok(result.locationNormalization.observations.some((item) => (
    item.source === 'description'
    && item.kind === 'work_arrangement'
    && item.arrangement === 'Remote'
    && item.raw === 'Location/Hybrid Policy: Remote'
  )));
});

test('provider arrangement outranks a conflicting labelled description policy', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      remoteType: 'Hybrid',
      description: 'Location/Hybrid Policy: Remote',
    }),
  ], { dictionary, locationScopeFilter });

  assert.equal(result.remoteType, 'Hybrid');
  assert.equal(result.locationNormalization.consistency, 'conflicting');
  assert.ok(result.locationNormalization.observations.some((item) => (
    item.source === 'description'
    && item.kind === 'work_arrangement'
    && item.arrangement === 'Remote'
  )));
});

test('casual remote wording and hashtags do not set work arrangement', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      description: 'You will collaborate with remote teams around the world. #LI-Remote',
    }),
  ], { dictionary, locationScopeFilter });

  assert.equal(result.remoteType, 'Unknown');
  assert.ok(!result.locationNormalization.observations.some((item) => (
    item.source === 'description' && item.kind === 'work_arrangement'
  )));
});

test('multiple conflicting labelled policies fail open instead of choosing one', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      description: 'Work Arrangement: Remote\nWorkplace Model: Hybrid',
    }),
  ], { dictionary, locationScopeFilter });

  assert.equal(result.remoteType, 'Unknown');
  assert.equal(result.locationNormalization.consistency, 'conflicting');
});

test('labelled policy is detected across HTML list boundaries', () => {
  const [result] = normalizeCandidateLocations([
    candidate({
      description: '<ul><li>Employment Type: Full-time</li><li>Location/Hybrid Policy: Remote</li></ul>',
    }),
  ], { dictionary, locationScopeFilter });

  assert.equal(result.remoteType, 'Remote');
});
