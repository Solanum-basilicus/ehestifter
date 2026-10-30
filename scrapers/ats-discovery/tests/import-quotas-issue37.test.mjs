import assert from 'node:assert/strict';
import test from 'node:test';

import { importCandidates } from '../src/ehestifter/import-jobs.mjs';

const USERS = ['u-a', 'u-b', 'u-c', 'u-d', 'u-e'];

function candidate(id, matchedUserIds, changes = {}) {
  return {
    sourceProvider: 'greenhouse',
    url: `https://job-boards.greenhouse.io/example/jobs/${id}`,
    applyUrl: `https://job-boards.greenhouse.io/example/jobs/${id}`,
    foundOn: 'ats-discovery',
    sourceCompany: 'Example',
    hiringCompanyName: 'Example',
    title: 'Engineer',
    remoteType: 'Remote',
    description: 'Complete job description.',
    locationsV2: [],
    canonicalIdentity: {
      provider: 'greenhouse', providerTenant: 'example', externalId: String(id),
    },
    preflight: { status: 'ok', exists: false },
    matchedUserIds,
    ...changes,
  };
}

function client() {
  const calls = [];
  return {
    calls,
    async createJob(payload) {
      calls.push(payload);
      return {
        id: `job-${payload.externalId}`, disposition: 'submitted',
        reconciled: false, responseStatus: 201,
      };
    },
  };
}

test('five user queues receive sponsorship slots plus one shared stretch slot', async () => {
  const jobs = USERS.flatMap((user, index) => Array.from({ length: 3 }, (_, i) => (
    candidate(`${index}-${i}`, [user])
  )));
  jobs.push(candidate('shared-1', [USERS[0], USERS[1]]));
  jobs.push(candidate('shared-2', [USERS[2], USERS[3]]));
  const jobsClient = client();
  const results = await importCandidates(jobs, jobsClient, {
    maxCreatesPerUser: 2, sharedCreates: 1, eligibleUserIds: USERS,
    requireDescription: true,
  });
  assert.equal(jobsClient.calls.length, 11);
  assert.equal(results.filter((item) => item.import.admissionPool === 'user').length, 10);
  assert.equal(results.filter((item) => item.import.admissionPool === 'shared').length, 1);
  assert.equal(results.filter((item) => item.import.status === 'skipped_user_quota').length, 6);
  for (const userId of USERS) {
    assert.equal(results.filter((item) => item.import.sponsoredByUserId === userId).length, 2);
  }
});

test('shared jobs use one sponsor and do not consume the other user slot', async () => {
  const jobsClient = client();
  const results = await importCandidates([
    candidate('shared', ['u-a', 'u-b']),
    candidate('b-only', ['u-b']),
  ], jobsClient, {
    maxCreatesPerUser: 1, sharedCreates: 0, eligibleUserIds: ['u-a', 'u-b'],
    requireDescription: true,
  });
  assert.equal(jobsClient.calls.length, 2);
  assert.deepEqual(results.map((item) => item.import.sponsoredByUserId), ['u-a', 'u-b']);
  assert.deepEqual(results[0].matchedUserIds, ['u-a', 'u-b']);
});

test('existing jobs and incomplete descriptions do not consume create slots', async () => {
  const jobsClient = client();
  const results = await importCandidates([
    candidate('existing', ['u-a'], {
      preflight: { status: 'ok', exists: true }, existingJobId: 'existing-id',
    }),
    candidate('incomplete', ['u-a'], { description: '' }),
    candidate('ready', ['u-a']),
  ], jobsClient, {
    maxCreatesPerUser: 1, sharedCreates: 2, eligibleUserIds: ['u-a'],
    requireDescription: true,
  });
  assert.equal(jobsClient.calls.length, 1);
  assert.deepEqual(results.map((item) => item.import.status), [
    'existing_preflight', 'skipped_missing_description', 'submitted',
  ]);
});

test('failed submissions consume a sponsorship slot', async () => {
  let calls = 0;
  const results = await importCandidates([
    candidate('first', ['u-a']), candidate('second', ['u-a']),
  ], { async createJob() { calls += 1; throw new Error('network failed'); } }, {
    maxCreatesPerUser: 1, sharedCreates: 0, eligibleUserIds: ['u-a'],
    requireDescription: true,
  });
  assert.equal(calls, 1);
  assert.deepEqual(results.map((item) => item.import.status), [
    'error', 'skipped_user_quota',
  ]);
});

test('no stretch pool is used with a single user', async () => {
  const jobsClient = client();
  const results = await importCandidates([
    candidate('1', ['u-a']), candidate('2', ['u-a']),
  ], jobsClient, {
    maxCreatesPerUser: 1, sharedCreates: 50, eligibleUserIds: ['u-a'],
    requireDescription: true,
  });
  assert.equal(jobsClient.calls.length, 1);
  assert.equal(results[1].import.status, 'skipped_user_quota');
});

test('invalid create payload does not consume the next valid sponsorship slot', async () => {
  const jobsClient = client();
  const results = await importCandidates([
    candidate('invalid', ['u-a'], { canonicalIdentity: null }),
    candidate('valid', ['u-a']),
  ], jobsClient, {
    maxCreatesPerUser: 1, sharedCreates: 0, eligibleUserIds: ['u-a'],
    requireDescription: true,
  });
  assert.equal(jobsClient.calls.length, 1);
  assert.deepEqual(results.map((item) => item.import.status), [
    'skipped_invalid_payload', 'submitted',
  ]);
});
