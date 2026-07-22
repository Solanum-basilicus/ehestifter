import test from 'node:test';
import assert from 'node:assert/strict';

import { enrichCandidateDetails } from '../src/details/fetchers.mjs';
import { importCandidates } from '../src/ehestifter/import-jobs.mjs';
import { preflightCandidates } from '../src/ehestifter/jobs-client.mjs';
import { executeProviderTargets } from '../src/scan/provider-executor.mjs';
import { parseDiscoveryPolicy } from '../src/policy/discovery-policy.mjs';

function candidate(overrides = {}) {
  return {
    schemaVersion: 1,
    sourceMode: 'catalog',
    sourceProvider: 'ashby',
    sourceCompany: 'acme',
    url: 'https://jobs.ashbyhq.com/acme/job-1',
    applyUrl: 'https://jobs.ashbyhq.com/acme/job-1',
    title: 'Product Manager',
    hiringCompanyName: 'Acme',
    postingCompanyName: null,
    foundOn: 'career-ops-scan',
    rawLocation: 'Remote Europe',
    locations: [],
    remoteType: 'Remote',
    description: 'Description',
    descriptionStatus: 'provider-list',
    canonicalIdentity: {
      provider: 'ashby',
      providerTenant: 'acme',
      externalId: 'job-1',
    },
    existingJobId: null,
    preflight: null,
    ...overrides,
  };
}

test('preflight reports monotonic completion under concurrency', async () => {
  const events = [];
  const result = await preflightCandidates(
    [candidate(), candidate({ url: 'https://example.test/2' })],
    {
      async existsByUrl(url) {
        return {
          exists: false,
          id: null,
          identity: {
            provider: 'ashby',
            providerTenant: 'acme',
            externalId: url.endsWith('/2') ? '2' : '1',
          },
          urlInference: {},
        };
      },
    },
    2,
    { onProgress: (event) => events.push(event) },
  );
  assert.equal(result.length, 2);
  assert.deepEqual(events.map((event) => event.current), [1, 2]);
  assert.equal(events.every((event) => event.total === 2), true);
});

test('preflight progress callback failure does not alter results', async () => {
  const result = await preflightCandidates(
    [candidate()],
    {
      async existsByUrl() {
        return {
          exists: true,
          id: 'job-id',
          identity: {
            provider: 'ashby',
            providerTenant: 'acme',
            externalId: 'job-1',
          },
          urlInference: {},
        };
      },
    },
    1,
    { onProgress: () => { throw new Error('ui failed'); } },
  );
  assert.equal(result[0].preflight.exists, true);
});

test('detail progress counts only actual selected detail fetches', async () => {
  const events = [];
  const result = await enrichCandidateDetails([
    candidate({
      canonicalIdentity: {
        provider: 'lever',
        providerTenant: 'acme',
        externalId: '1',
      },
      description: '',
      preflight: { status: 'ok', exists: false },
    }),
    candidate({
      preflight: { status: 'ok', exists: true },
      existingJobId: 'existing',
    }),
  ], {
    concurrency: 2,
    maxFetches: 10,
    timeoutMs: 1000,
    onProgress: (event) => events.push(event),
  });
  assert.equal(result[0].detail.status, 'unsupported_provider');
  assert.equal(result[1].detail.status, 'skipped_existing');
  assert.deepEqual(events, [{ stage: 'details', current: 1, total: 1 }]);
});

test('import progress covers every evaluated candidate while create cap remains enforced', async () => {
  const events = [];
  let creates = 0;
  const result = await importCandidates([
    candidate({ preflight: { status: 'ok', exists: false } }),
    candidate({
      url: 'https://jobs.ashbyhq.com/acme/job-2',
      canonicalIdentity: {
        provider: 'ashby',
        providerTenant: 'acme',
        externalId: 'job-2',
      },
      preflight: { status: 'ok', exists: false },
    }),
  ], {
    async createJob() {
      creates += 1;
      return {
        id: 'created-id',
        disposition: 'submitted',
        reconciled: false,
        responseStatus: 201,
      };
    },
  }, {
    maxCreates: 1,
    requireDescription: true,
    onProgress: (event) => events.push(event),
  });
  assert.equal(creates, 1);
  assert.equal(result[0].import.status, 'submitted');
  assert.equal(result[1].import.status, 'skipped_create_limit');
  assert.deepEqual(events.map((event) => event.current), [1, 2]);
});

test('provider executor progress reports completed targets and survives callback errors', async () => {
  const policy = parseDiscoveryPolicy({
    schema_version: 1,
    providers: {
      ashby: {
        catalog_enabled: true,
        max_normal_targets_per_run: 10,
        target_full_sweep_days: 3,
        execution: {
          concurrency: 2,
          min_request_interval_ms: 0,
        },
      },
    },
  });
  const events = [];
  const targets = [0, 1, 2].map((sequence) => ({
    sequence,
    provider: 'ashby',
    tenant: `tenant-${sequence}`,
    targetClass: 'normal',
  }));
  const result = await executeProviderTargets({
    targets,
    policy,
    globalConcurrency: 3,
    fetchTarget: async () => [],
    onProgress: (event) => {
      events.push(event);
      if (event.current === 2) throw new Error('renderer failed');
    },
  });
  assert.equal(result.batches.length, 3);
  assert.deepEqual(events.map((event) => event.current), [1, 2, 3]);
  assert.equal(events.every((event) => event.total === 3), true);
});
