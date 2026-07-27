import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createUsersClient,
  validateDiscoveryUsersPayload,
} from '../src/ehestifter/users-client.mjs';

const USER = '11111111-1111-4111-8111-111111111111';
const CV = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function payload() {
  return {
    schemaVersion: 1,
    generatedAtUtc: '2026-07-24T00:00:00Z',
    users: [{
      userId: USER,
      cvVersionId: CV,
      cvLastUpdatedUtc: '2026-07-23T00:00:00Z',
      hasSavedFilters: true,
      invalidProfileCount: 0,
      profiles: [{
        profileId: 'filter',
        title: { positive: ['Manager'], negative: [] },
        location: { alwaysAllow: [], allow: ['Germany'], block: [] },
        company: { allow: [], block: [] },
        remoteTypes: ['Remote'],
      }],
    }],
  };
}

test('validates and sorts the bounded discovery-user contract', () => {
  const result = validateDiscoveryUsersPayload(payload(), { maxUsers: 2 });
  assert.equal(result.users[0].userId, USER);
  assert.deepEqual(result.users[0].profiles[0].title.positive, ['Manager']);
});

test('rejects duplicate users, invalid GUIDs, and excessive user counts', () => {
  const duplicated = payload();
  duplicated.users.push(structuredClone(duplicated.users[0]));
  assert.throws(() => validateDiscoveryUsersPayload(duplicated), /duplicate/);
  const invalid = payload();
  invalid.users[0].userId = 'not-a-guid';
  assert.throws(() => validateDiscoveryUsersPayload(invalid), /GUID/);
  assert.throws(() => validateDiscoveryUsersPayload(payload(), { maxUsers: 0 }), /exceeds/);
});

test('Users client uses the internal endpoint and function key', async () => {
  let request;
  const client = createUsersClient({
    baseUrl: 'https://users.example/api',
    functionKey: 'secret',
    timeoutMs: 1000,
    retryCount: 0,
    maxUsersPerRun: 10,
  }, {
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return new Response(JSON.stringify(payload()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const result = await client.listDiscoveryEligible();
  assert.equal(result.users.length, 1);
  assert.equal(request.url, 'https://users.example/api/users/internal/discovery-eligible?limit=10');
  assert.equal(request.options.headers['x-functions-key'], 'secret');
});


test('CV version identifiers are opaque bounded tokens rather than GUIDs', () => {
  const valid = payload();
  valid.users[0].cvVersionId = 'a'.repeat(64);
  assert.equal(
    validateDiscoveryUsersPayload(valid).users[0].cvVersionId,
    'a'.repeat(64),
  );

  const empty = payload();
  empty.users[0].cvVersionId = '   ';
  assert.throws(
    () => validateDiscoveryUsersPayload(empty),
    /bounded version identifier/,
  );

  const control = payload();
  control.users[0].cvVersionId = 'abc\n123';
  assert.throws(
    () => validateDiscoveryUsersPayload(control),
    /bounded version identifier/,
  );
});

test('Users discovery contract rejects constraint-free profiles and schema drift', () => {
  const emptyProfile = payload();
  emptyProfile.users[0].profiles[0] = {
    profileId: 'filter',
    title: { positive: [], negative: [] },
    location: { alwaysAllow: [], allow: [], block: [] },
    company: { allow: [], block: [] },
    remoteTypes: [],
  };
  assert.throws(
    () => validateDiscoveryUsersPayload(emptyProfile),
    /at least one discovery constraint/,
  );

  const invalidBoolean = payload();
  invalidBoolean.users[0].hasSavedFilters = 'yes';
  assert.throws(
    () => validateDiscoveryUsersPayload(invalidBoolean),
    /hasSavedFilters must be a boolean/,
  );

  const invalidTimestamp = payload();
  invalidTimestamp.generatedAtUtc = 'not-a-time';
  assert.throws(
    () => validateDiscoveryUsersPayload(invalidTimestamp),
    /generatedAtUtc must be a valid timestamp/,
  );
});

test('successful but invalid Users payload is not retried', async () => {
  let attempts = 0;
  const client = createUsersClient({
    baseUrl: 'https://users.example/api',
    functionKey: 'secret',
    timeoutMs: 1000,
    retryCount: 3,
    maxUsersPerRun: 10,
  }, {
    fetchImpl: async () => {
      attempts += 1;
      return new Response(JSON.stringify({ schemaVersion: 99, users: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  await assert.rejects(client.listDiscoveryEligible(), /schemaVersion/);
  assert.equal(attempts, 1);
});
