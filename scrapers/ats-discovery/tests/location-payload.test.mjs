import test from 'node:test';
import assert from 'node:assert/strict';

import { createGeoDictionary } from '../src/locations/geo-dictionary.mjs';
import { buildCreatePayload } from '../src/ehestifter/job-payload.mjs';

const dictionary = createGeoDictionary({
  schemaVersion: 1,
  countries: [
    { name: 'Germany', code: 'DE', priority: true },
    { name: 'United States', code: 'US', priority: true },
  ],
  cities: { DE: ['Berlin'], US: ['Washington'] },
});

function candidate(locations) {
  return {
    url: 'https://example.test/job/1',
    applyUrl: 'https://example.test/job/1',
    foundOn: 'ats-discovery',
    sourceProvider: 'greenhouse',
    title: 'Engineer',
    hiringCompanyName: 'Example',
    remoteType: 'Remote',
    description: 'Description',
    locations,
    canonicalIdentity: {
      provider: 'greenhouse', providerTenant: 'example', externalId: '1',
    },
  };
}

test('payload emits canonical name, code, and city', () => {
  const payload = buildCreatePayload(candidate([{
    countryName: 'Deutschland',
    countryCode: 'DE',
    cityName: 'berlin',
    region: null,
  }]), { dictionary });
  assert.deepEqual(payload.locations, [{
    countryName: 'Germany',
    countryCode: 'DE',
    cityName: 'Berlin',
    region: null,
  }]);
});

test('payload rejects inconsistent canonical pairs', () => {
  assert.throws(() => buildCreatePayload(candidate([{
    countryName: 'United States',
    countryCode: 'DE',
    cityName: null,
    region: null,
  }]), { dictionary }), /mismatch/u);
});

test('payload rejects unresolved cities instead of guessing', () => {
  assert.throws(() => buildCreatePayload(candidate([{
    countryName: 'Germany',
    countryCode: 'DE',
    cityName: 'Washington',
    region: null,
  }]), { dictionary }), /Unknown city/u);
});


test('payload dual-writes legacy and native v2 location contracts', () => {
  const input = candidate([{
    countryName: 'Germany', countryCode: 'DE', cityName: 'Berlin', region: null,
  }]);
  input.locationsV2 = [{ kind: 'country', locationId: 'iso3166:DE' }];
  input.workTimeConstraintsV2 = [{
    offsetRangeStartMinutes: -300,
    offsetRangeEndMinutes: -240,
  }];
  const v2Catalog = {
    get(kind, locationId) {
      return kind === 'country' && locationId === 'iso3166:DE'
        ? { kind, id: locationId }
        : null;
    },
  };
  const payload = buildCreatePayload(input, { dictionary, v2Catalog });
  assert.equal(payload.locations.length, 1);
  assert.deepEqual(payload.locationsV2, [{ kind: 'country', locationId: 'iso3166:DE' }]);
  assert.deepEqual(payload.workTimeConstraintsV2, [{
    offsetRangeStartMinutes: -300,
    offsetRangeEndMinutes: -240,
  }]);
});

test('payload rejects invalid canonical v2 selectors', () => {
  const input = candidate([]);
  input.locationsV2 = [{ kind: 'country', locationId: 'iso3166:ZZ' }];
  assert.throws(
    () => buildCreatePayload(input, {
      dictionary,
      v2Catalog: { get() { return null; } },
    }),
    /Invalid Locations v2 selector/u,
  );
});
