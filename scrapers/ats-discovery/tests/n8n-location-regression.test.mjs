import test from 'node:test';
import assert from 'node:assert/strict';

import { createGeoDictionary } from '../src/locations/geo-dictionary.mjs';
import { normalizeCandidateLocations } from '../src/locations/normalizer.mjs';

const countryEntries = [
  ['Bosnia and Herzegovina', 'BA'],
  ['Romania', 'RO'],
  ['Norway', 'NO'],
  ['Estonia', 'EE'],
  ['Latvia', 'LV'],
  ['Slovenia', 'SI'],
  ['Italy', 'IT'],
  ['Netherlands', 'NL'],
  ['Hungary', 'HU'],
  ['Moldova', 'MD'],
  ['Kosovo', 'XK'],
  ['Portugal', 'PT'],
  ['France', 'FR'],
  ['Poland', 'PL'],
  ['Serbia', 'RS'],
  ['Germany', 'DE'],
  ['Austria', 'AT'],
  ['Finland', 'FI'],
  ['Montenegro', 'ME'],
  ['United Kingdom', 'GB'],
  ['Albania', 'AL'],
  ['Lithuania', 'LT'],
  ['Slovakia', 'SK'],
  ['Ireland', 'IE'],
  ['Bulgaria', 'BG'],
  ['Denmark', 'DK'],
  ['Belgium', 'BE'],
  ['Czechia', 'CZ'],
  ['Croatia', 'HR'],
  ['Spain', 'ES'],
  ['Greece', 'GR'],
  ['Ukraine', 'UA'],
  ['Sweden', 'SE'],
];

const dictionary = createGeoDictionary({
  schemaVersion: 1,
  countries: countryEntries.map(([name, code]) => ({ name, code, priority: false })),
  cities: Object.fromEntries(countryEntries.map(([_name, code]) => [code, []])),
});
dictionary.countriesByCode.get('DE');

// The source snapshot contains the city lists. Add only the relevant fixtures
// by constructing a second dictionary with the same country vocabulary.
const cities = Object.fromEntries(countryEntries.map(([_name, code]) => [code, []]));
cities.DE = ['Berlin', 'Hamburg'];
cities.GB = ['London'];
const dictionaryWithCities = createGeoDictionary({
  schemaVersion: 1,
  countries: countryEntries.map(([name, code]) => ({ name, code, priority: false })),
  cities,
});

const rawLocation = 'Berlin Office · Bosnia · Romania · Norway · Estonia · Latvia · Slovenia · Italy · Netherlands · Hungary · Moldova · Kosovo · Portugal · France · Poland · Serbia · Germany · Austria · Finland · Montenegro · London Office · London · United Kingdom · Albania · Lithuania · Slovakia · Ireland · Bulgaria · Denmark · Belgium · Czech Republic · Croatia · Spain · Greece · Ukraine · Sweden';

const locationScopeFilter = {
  enabled: true,
  allow: ['Germany', 'Europe', 'EU', 'EEA', 'EMEA'],
  block: ['Bosnia', 'United Kingdom', 'France'],
  restriction_markers: ['only', 'based', 'resident', 'remote in'],
};

test('n8n multi-country location keeps unique listed-country cities, Bosnia, and title Remote', () => {
  const [result] = normalizeCandidateLocations([{
    title: 'Engineering Manager | Remote | Europe',
    rawLocation,
    locations: [],
    remoteType: 'Unknown',
    description: '',
    preflight: { status: 'ok', exists: true },
  }], { dictionary: dictionaryWithCities, locationScopeFilter });

  assert.equal(result.remoteType, 'Remote');
  assert.ok(result.locations.some((item) => (
    item.countryCode === 'DE' && item.cityName === 'Berlin'
  )));
  assert.ok(result.locations.some((item) => (
    item.countryCode === 'GB' && item.cityName === 'London'
  )));
  assert.ok(result.locations.some((item) => (
    item.countryCode === 'BA'
    && item.countryName === 'Bosnia and Herzegovina'
    && item.cityName === null
  )));
  assert.ok(result.locationNormalization.observations.some((item) => (
    item.source === 'title'
    && item.kind === 'work_arrangement'
    && item.arrangement === 'Remote'
  )));
  assert.ok(result.locationNormalization.observations.some((item) => (
    item.raw === 'Berlin Office'
    && item.kind === 'city_with_listed_country'
    && item.location?.countryCode === 'DE'
  )));
  assert.ok(result.locationNormalization.observations.some((item) => (
    item.raw === 'London Office'
    && item.kind === 'city_with_listed_country'
    && item.location?.countryCode === 'GB'
  )));
  assert.ok(!result.locationNormalization.unresolved.some(
    (item) => ['Berlin Office', 'Bosnia', 'London Office', 'London'].includes(item.raw),
  ));
});

test('standalone city still does not acquire a guessed country', () => {
  const [result] = normalizeCandidateLocations([{
    title: 'Product Manager',
    rawLocation: 'Hamburg',
    locations: [],
    remoteType: 'Unknown',
    description: '',
    preflight: { status: 'ok', exists: false },
  }], { dictionary: dictionaryWithCities, locationScopeFilter });

  assert.deepEqual(result.locations, []);
  assert.equal(result.locationNormalization.status, 'unparsed_single_value');
});

test('explicit provider work arrangement outranks a conflicting title cue', () => {
  const [result] = normalizeCandidateLocations([{
    title: 'Engineering Manager | Remote',
    rawLocation: 'Germany',
    locations: [],
    remoteType: 'Hybrid',
    description: '',
    preflight: { status: 'ok', exists: false },
  }], { dictionary: dictionaryWithCities, locationScopeFilter });

  assert.equal(result.remoteType, 'Hybrid');
  assert.ok(!result.locationNormalization.observations.some(
    (item) => item.source === 'title' && item.kind === 'work_arrangement',
  ));
});

test('Bosnia aliases resolve to canonical Web GEO country', () => {
  assert.deepEqual(dictionary.resolveCountry('Bosnia'), {
    countryName: 'Bosnia and Herzegovina',
    countryCode: 'BA',
  });
  assert.deepEqual(dictionary.resolveCountry('Bosnia-Herzegovina'), {
    countryName: 'Bosnia and Herzegovina',
    countryCode: 'BA',
  });
});


test('domain words in a title do not imply a remote work arrangement', () => {
  const [result] = normalizeCandidateLocations([{
    title: 'Remote Sensing Engineer',
    rawLocation: 'Germany',
    locations: [],
    remoteType: 'Unknown',
    description: '',
    preflight: { status: 'ok', exists: false },
  }], { dictionary: dictionaryWithCities, locationScopeFilter });

  assert.equal(result.remoteType, 'Unknown');
  assert.ok(!result.locationNormalization.observations.some(
    (item) => item.source === 'title' && item.kind === 'work_arrangement',
  ));
});
