import test from 'node:test';
import assert from 'node:assert/strict';

import { importCandidates } from '../src/ehestifter/import-jobs.mjs';

function candidate(overrides = {}) {
  return {
    url: 'https://example.test/jobs/1',
    applyUrl: 'https://example.test/jobs/1',
    foundOn: 'ats-discovery',
    title: 'Engineer',
    hiringCompanyName: 'Example',
    remoteType: 'Remote',
    description: 'Description',
    locations: [],
    canonicalIdentity: {
      provider: 'greenhouse',
      providerTenant: 'example',
      externalId: '1',
    },
    preflight: { status: 'ok', exists: false },
    ...overrides,
  };
}

test('decisively ineligible candidates are skipped without consuming create cap', async () => {
  const calls = [];
  const client = {
    async createJob(payload) {
      calls.push(payload);
      return {
        id: 'job-2',
        disposition: 'submitted',
        reconciled: false,
        responseStatus: 201,
      };
    },
  };
  const results = await importCandidates([
    candidate({
      locationEligibility: {
        status: 'ineligible',
        reason: 'restriction_scope',
        consistency: 'refined',
      },
    }),
    candidate({
      url: 'https://example.test/jobs/2',
      applyUrl: 'https://example.test/jobs/2',
      canonicalIdentity: {
        provider: 'greenhouse', providerTenant: 'example', externalId: '2',
      },
      locationEligibility: { status: 'unclear' },
    }),
  ], client, { maxCreates: 1, requireDescription: true });

  assert.equal(results[0].import.status, 'skipped_location_ineligible');
  assert.equal(results[1].import.status, 'submitted');
  assert.equal(calls.length, 1);
});

test('existing records are returned before the location gate', async () => {
  const [result] = await importCandidates([
    candidate({
      existingJobId: 'existing-1',
      preflight: { status: 'ok', exists: true },
      locationEligibility: { status: 'ineligible' },
    }),
  ], { createJob: async () => assert.fail('must not create') }, {
    maxCreates: 1,
    requireDescription: true,
  });
  assert.equal(result.import.status, 'existing_preflight');
});

test('unresolved Hybrid location remains importable while inference matures', async () => {
  const calls = [];
  const [result] = await importCandidates([
    candidate({
      remoteType: 'Hybrid',
      locations: [],
      locationEligibility: {
        status: 'unclear',
        reason: 'insufficient_explicit_location_evidence',
      },
    }),
  ], {
    async createJob(payload) {
      calls.push(payload);
      return {
        id: 'job-hybrid',
        disposition: 'submitted',
        reconciled: false,
        responseStatus: 201,
      };
    },
  }, { maxCreates: 1, requireDescription: true });

  assert.equal(result.import.status, 'submitted');
  assert.equal(calls.length, 1);
});
