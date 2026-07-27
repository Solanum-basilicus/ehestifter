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
  refreshSucceededWithUnknownCvVersion: false,
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

test('skips active and current successful runs and refreshes changed CVs', async () => {
  const creates = [];
  const latestByUser = new Map([
    [USER_A, { runId: 'run-a', status: 'Succeeded', cvVersionId: CV_A }],
    [USER_B, { runId: 'run-b', status: 'Succeeded', cvVersionId: CV_A }],
  ]);
  const result = await requestCompatibilityForMatches({
    importResults: [imported()],
    discoveryUsers: users,
    client: {
      getLatest: async (_job, user) => latestByUser.get(user),
      createRun: async (job, user) => {
        creates.push([job, user]);
        return { runId: `new-${user}`, status: 'Queued', cvVersionId: CV_B };
      },
    },
    config: baseConfig,
  });
  assert.deepEqual(result.results.map((item) => item.status), [
    'skipped_succeeded_current_cv',
    'requested',
  ]);
  assert.deepEqual(creates, [[JOB_A, USER_B]]);
});

test('missing, failed, and expired runs are requestable while active runs are not', async () => {
  const latest = new Map([
    [USER_A, { status: 'Queued', cvVersionId: CV_A }],
    [USER_B, { status: 'Failed', cvVersionId: CV_B }],
  ]);
  const result = await requestCompatibilityForMatches({
    importResults: [imported()],
    discoveryUsers: users,
    client: {
      getLatest: async (_job, user) => latest.get(user) ?? null,
      createRun: async () => ({ runId: 'new', status: 'Pending' }),
    },
    config: baseConfig,
  });
  assert.deepEqual(result.results.map((item) => item.status), [
    'skipped_active',
    'requested',
  ]);
});

test('pair and request caps are explicit and deterministic', async () => {
  const result = await requestCompatibilityForMatches({
    importResults: [
      imported(),
      imported({ import: { status: 'submitted', jobId: JOB_B } }),
    ],
    discoveryUsers: users,
    client: {
      getLatest: async () => null,
      createRun: async () => ({ runId: 'new', status: 'Queued' }),
    },
    config: { ...baseConfig, maxPairsPerRun: 3, maxRequestsPerRun: 1 },
  });
  assert.equal(result.totalPairs, 4);
  assert.equal(result.evaluatedPairs, 3);
  assert.equal(result.omittedPairs, 1);
  assert.deepEqual(result.results.map((item) => item.status), [
    'requested',
    'skipped_request_limit',
    'skipped_request_limit',
  ]);
});

test('latest-check and create failures remain pair-local diagnostics', async () => {
  const result = await requestCompatibilityForMatches({
    importResults: [imported()],
    discoveryUsers: users,
    client: {
      getLatest: async (_job, user) => {
        if (user === USER_A) throw new Error('latest down');
        return null;
      },
      createRun: async () => { throw new Error('create down'); },
    },
    config: baseConfig,
  });
  assert.deepEqual(result.results.map((item) => item.status), [
    'error_latest_check',
    'error_request',
  ]);
});
