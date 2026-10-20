import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCompatibilityPairs,
  requestCompatibilityForMatches,
} from '../src/ehestifter/request-compatibility.mjs';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const CV_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CV_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const JOB_A = '33333333-3333-4333-8333-333333333333';
const JOB_B = '44444444-4444-4444-8444-444444444444';

const users = [
  { userId: USER_A, cvVersionId: CV_A },
  { userId: USER_B, cvVersionId: CV_B },
];

function imported(overrides = {}) {
  return {
    url: 'https://example.test/job',
    sourceProvider: 'greenhouse',
    matchedUserIds: [USER_A, USER_B],
    import: { status: 'submitted', jobId: JOB_A },
    ...overrides,
  };
}

const baseConfig = {
  enricherType: 'compatibility.v1',
  concurrency: 2,
  maxPairsPerRun: 100,
  maxRequestsPerRun: 20,
};

test('builds one deterministic pair per job and matched user', () => {
  const pairs = buildCompatibilityPairs(
    [imported(), imported(), imported({ import: { status: 'submitted', jobId: JOB_B }, matchedUserIds: [USER_A] })],
    users,
  );
  assert.deepEqual(pairs.map((pair) => [pair.jobId, pair.userId]), [
    [JOB_A, USER_A],
    [JOB_A, USER_B],
    [JOB_B, USER_A],
  ]);
});

test('delegates all enrichment decisions to Enrichment Core', async () => {
  const creates = [];
  const result = await requestCompatibilityForMatches({
    importResults: [imported()],
    discoveryUsers: users,
    client: {
      createRun: async (job, user) => {
        creates.push([job, user]);
        return user === USER_A
          ? { runId: 'existing', status: 'Succeeded', decision: 'reused' }
          : { runId: 'new', status: 'Queued', decision: 'created' };
      },
    },
    config: baseConfig,
  });
  assert.deepEqual(result.results.map((item) => item.status), [
    'skipped_reused', 'requested',
  ]);
  assert.deepEqual(creates, [[JOB_A, USER_A], [JOB_A, USER_B]]);
});

test('permanent failures are suppressed by Enrichment Core', async () => {
  const result = await requestCompatibilityForMatches({
    importResults: [imported()],
    discoveryUsers: users,
    client: {
      createRun: async () => ({
        runId: 'old', status: 'Failed', decision: 'suppressed',
      }),
    },
    config: baseConfig,
  });
  assert.deepEqual(result.results.map((item) => item.status), [
    'skipped_suppressed', 'skipped_suppressed',
  ]);
});

test('pair and request limits remain deterministic', async () => {
  const result = await requestCompatibilityForMatches({
    importResults: [
      imported(),
      imported({ import: { status: 'submitted', jobId: JOB_B } }),
    ],
    discoveryUsers: users,
    client: { createRun: async () => ({ runId: 'new', status: 'Queued', decision: 'created' }) },
    config: { ...baseConfig, maxPairsPerRun: 3, maxRequestsPerRun: 1 },
  });
  assert.equal(result.totalPairs, 4);
  assert.equal(result.evaluatedPairs, 3);
  assert.equal(result.omittedPairs, 1);
  assert.deepEqual(result.results.map((item) => item.status), [
    'requested', 'skipped_request_limit', 'skipped_request_limit',
  ]);
});

test('create failures remain local to each pair', async () => {
  const observed = [];
  const result = await requestCompatibilityForMatches({
    importResults: [imported()],
    discoveryUsers: users,
    client: {
      createRun: async () => { throw new Error('create down'); },
    },
    config: baseConfig,
    onResult: (item) => observed.push(item.status),
  });
  assert.deepEqual(result.results.map((item) => item.status), [
    'error_request', 'error_request',
  ]);
  assert.deepEqual(observed, ['error_request', 'error_request']);
});
