import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCreatePayload } from '../src/ehestifter/job-payload.mjs';

const validSelectors = new Set([
  'country\u0000iso3166:DE',
  'country\u0000iso3166:GB',
]);

const v2Catalog = {
  get(kind, locationId) {
    return validSelectors.has(`${kind}\u0000${locationId}`)
      ? { kind, id: locationId }
      : null;
  },
};

function candidate(overrides = {}) {
  return {
    url: 'https://example.test/job/1',
    applyUrl: 'https://example.test/job/1',
    foundOn: 'ats-discovery',
    sourceProvider: 'greenhouse',
    title: 'Engineer',
    hiringCompanyName: 'Example',
    remoteType: 'Remote',
    description: 'Description',
    locations: [],
    locationsV2: [],
    workTimeConstraintsV2: [],
    canonicalIdentity: {
      provider: 'greenhouse', providerTenant: 'example', externalId: '1',
    },
    ...overrides,
  };
}

test('payload sends native v2 geography without legacy locations', () => {
  const payload = buildCreatePayload(candidate({
    locations: [{
      countryName: 'Germany', countryCode: 'DE', cityName: 'Berlin', region: null,
    }],
    locationsV2: [{ kind: 'country', locationId: 'iso3166:DE' }],
    workTimeConstraintsV2: [{
      offsetRangeStartMinutes: -300,
      offsetRangeEndMinutes: -240,
    }],
  }), { v2Catalog });

  assert.equal(Object.hasOwn(payload, 'locations'), false);
  assert.deepEqual(payload.locationsV2, [
    { kind: 'country', locationId: 'iso3166:DE' },
  ]);
  assert.deepEqual(payload.workTimeConstraintsV2, [{
    offsetRangeStartMinutes: -300,
    offsetRangeEndMinutes: -240,
  }]);
});

test('legacy provider location evidence cannot reject a valid v2 payload', () => {
  const payload = buildCreatePayload(candidate({
    locations: [{
      countryName: 'Germany',
      countryCode: 'DE',
      cityName: 'DEU AAG Münster - AAS',
      region: null,
    }],
    locationsV2: [{ kind: 'country', locationId: 'iso3166:DE' }],
  }), { v2Catalog });

  assert.equal(Object.hasOwn(payload, 'locations'), false);
  assert.deepEqual(payload.locationsV2, [
    { kind: 'country', locationId: 'iso3166:DE' },
  ]);
});

test('remote job with unknown geography remains representable', () => {
  const payload = buildCreatePayload(candidate({
    locations: [{
      countryName: 'Unknown provider value',
      countryCode: null,
      cityName: 'Home Working, GB',
      region: null,
    }],
    locationsV2: [],
  }), { v2Catalog });

  assert.equal(payload.remoteType, 'Remote');
  assert.equal(Object.hasOwn(payload, 'locations'), false);
  assert.deepEqual(payload.locationsV2, []);
});

test('payload keeps independent v2 location alternatives', () => {
  const payload = buildCreatePayload(candidate({
    locationsV2: [
      { kind: 'country', locationId: 'iso3166:DE' },
      { kind: 'country', locationId: 'iso3166:GB' },
      { kind: 'country', locationId: 'iso3166:DE' },
    ],
  }), { v2Catalog });

  assert.deepEqual(payload.locationsV2, [
    { kind: 'country', locationId: 'iso3166:DE' },
    { kind: 'country', locationId: 'iso3166:GB' },
  ]);
});

test('payload rejects invalid canonical v2 selectors', () => {
  assert.throws(
    () => buildCreatePayload(candidate({
      locationsV2: [{ kind: 'country', locationId: 'iso3166:ZZ' }],
    }), { v2Catalog }),
    /Invalid Locations v2 selector/u,
  );
});
