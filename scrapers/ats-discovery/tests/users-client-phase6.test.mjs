import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createUsersClient,
  validateDiscoveryUsersPayload,
} from '../src/ehestifter/users-client.mjs';

const USER = '11111111-1111-4111-8111-111111111111';
const CV = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function preferences(overrides = {}) {
  return {
    schemaVersion: 1,
    title: {
      positive: ['Product Manager'],
      positivePatterns: [],
      negative: [],
    },
    eligibility: null,
    ...overrides,
  };
}

function payload() {
  return {
    schemaVersion: 1,
    generatedAtUtc: '2026-09-20T00:00:00Z',
    users: [{
      userId: USER,
      cvVersionId: CV,
      cvLastUpdatedUtc: '2026-09-19T00:00:00Z',
      discoveryPreferences: preferences(),
      discoveryPreferencesInvalid: false,
      discoveryPreferencesLastUpdatedUtc: '2026-09-20T00:00:00Z',
    }],
  };
}

test('validates the discovery-preference contract returned by Users', () => {
  const result = validateDiscoveryUsersPayload(payload(), { maxUsers: 2 });
  assert.equal(result.users[0].userId, USER);
  assert.deepEqual(
    result.users[0].discoveryPreferences.title.positive,
    ['Product Manager'],
  );
});

test('one malformed stored preference disables that user without rejecting the envelope', () => {
  const invalid = payload();
  invalid.users[0].discoveryPreferences.title.positivePatterns = [{
    type: 'regex', left: ['Engineering'], right: ['Manager'], maxGapWords: 2,
  }];
  const result = validateDiscoveryUsersPayload(invalid);
  assert.equal(result.users[0].discoveryPreferences, null);
  assert.equal(result.users[0].discoveryPreferencesInvalid, true);
  assert.match(result.users[0].discoveryPreferencesError, /orderedGap/u);
});

test('validates orderedGap and all eligibility fields but leaves UTC use to Jobs', () => {
  const value = payload();
  value.users[0].discoveryPreferences = preferences({
    title: {
      positive: [],
      positivePatterns: [{
        type: 'orderedGap', left: ['Engineering'], right: ['Manager', 'Lead'], maxGapWords: 2,
      }],
      negative: ['Intern'],
    },
    eligibility: {
      remote: {
        includeLocations: [{ kind: 'country', locationId: 'iso3166:DE' }],
        excludeLocations: [],
        utcOffsetRanges: [{ startMinutes: 60, endMinutes: 120 }],
        excludeWorkTimeRanges: [{ startMinutes: -300, endMinutes: -240 }],
        allowUnknownLocation: false,
      },
    },
  });
  const result = validateDiscoveryUsersPayload(value);
  assert.equal(result.users[0].discoveryPreferences.title.positivePatterns[0].maxGapWords, 2);
  assert.deepEqual(
    result.users[0].discoveryPreferences.eligibility.remote.utcOffsetRanges,
    [{ startMinutes: 60, endMinutes: 120 }],
  );
});

test('rejects duplicate users, invalid GUIDs, and excessive user counts', () => {
  const duplicated = payload();
  duplicated.users.push(structuredClone(duplicated.users[0]));
  assert.throws(() => validateDiscoveryUsersPayload(duplicated), /duplicate/u);
  const invalid = payload();
  invalid.users[0].userId = 'not-a-guid';
  assert.throws(() => validateDiscoveryUsersPayload(invalid), /GUID/u);
  assert.throws(() => validateDiscoveryUsersPayload(payload(), { maxUsers: 0 }), /exceeds/u);
});

test('Users client uses the internal endpoint and function key', async () => {
  let request;
  const client = createUsersClient({
    baseUrl: 'https://users.example/api', functionKey: 'secret', timeoutMs: 1000,
    retryCount: 0, maxUsersPerRun: 10,
  }, {
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return new Response(JSON.stringify(payload()), { status: 200 });
    },
  });
  const result = await client.listDiscoveryEligible();
  assert.equal(result.users.length, 1);
  assert.equal(request.url, 'https://users.example/api/users/internal/discovery-eligible?limit=10');
  assert.equal(request.options.headers['x-functions-key'], 'secret');
});

test('CV version identifiers are opaque bounded tokens', () => {
  const valid = payload();
  valid.users[0].cvVersionId = 'a'.repeat(64);
  assert.equal(validateDiscoveryUsersPayload(valid).users[0].cvVersionId, 'a'.repeat(64));
  const invalid = payload();
  invalid.users[0].cvVersionId = 'abc\n123';
  assert.throws(() => validateDiscoveryUsersPayload(invalid), /bounded version identifier/u);
});

test('successful but invalid Users envelope is not retried', async () => {
  let attempts = 0;
  const client = createUsersClient({
    baseUrl: 'https://users.example/api', functionKey: 'secret', timeoutMs: 1000,
    retryCount: 3, maxUsersPerRun: 10,
  }, {
    fetchImpl: async () => {
      attempts += 1;
      return new Response(JSON.stringify({ schemaVersion: 99, users: [] }), { status: 200 });
    },
  });
  await assert.rejects(client.listDiscoveryEligible(), /schemaVersion/u);
  assert.equal(attempts, 1);
});
