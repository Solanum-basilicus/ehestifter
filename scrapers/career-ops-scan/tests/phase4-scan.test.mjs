import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDiscoveryPolicy } from '../src/policy/discovery-policy.mjs';
import { runTrackedScan } from '../src/scan/tracked-source.mjs';

function policy() {
  return parseDiscoveryPolicy({
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
}

function target(provider) {
  return {
    sequence: 0,
    provider: 'ashby',
    tenant: 'acme',
    name: 'acme',
    careers_url: 'https://jobs.ashbyhq.com/acme',
    targetClass: 'normal',
    reason: 'ashby_catalog',
    lookbackStartUtc: '2026-07-17T00:00:00.000Z',
    lookbackUnbounded: false,
    catalog: null,
    _provider: provider,
  };
}

function job(id, location) {
  return {
    id,
    title: 'Product Manager',
    company: 'Acme',
    location,
    url: `https://jobs.ashbyhq.com/acme/${id}`,
    description: '',
  };
}

function portalConfig() {
  return {
    title_filter: { positive: ['Product Manager'] },
    location_scope_filter: {
      enabled: true,
      allow: ['Germany', 'Europe', 'EMEA', 'Worldwide', 'Anywhere'],
      block: ['United States', 'USA', 'US', 'Canada'],
    },
    location_filter: { allow: ['Remote', 'Germany', 'Europe'] },
    max_posting_age_days: 30,
  };
}

test('cheap location-scope hardening rejects explicit US/Canada-only remote jobs', async () => {
  const provider = {
    id: 'ashby',
    async fetch() {
      return [
        job('us', 'Remote (United States | Canada)'),
        job('eu', 'Remote Europe'),
        job('any', 'Remote'),
      ];
    },
  };
  const result = await runTrackedScan({
    portalConfig: portalConfig(),
    targets: [target(provider)],
    providers: new Map([['ashby', provider]]),
    policy: policy(),
    concurrency: 2,
    maxCandidates: 10,
    upstreamRef: 'test-ref',
  });

  assert.deepEqual(result.candidates.map((item) => item.url), [
    'https://jobs.ashbyhq.com/acme/eu',
    'https://jobs.ashbyhq.com/acme/any',
  ]);
  const rejected = result.rejected.find(
    (item) => item.reason === 'location_scope_filter',
  );
  assert.equal(rejected.candidate.url, 'https://jobs.ashbyhq.com/acme/us');
  assert.deepEqual(rejected.details.blockedMatches.sort(), [
    'Canada', 'United States',
  ]);
});

test('location-scope filtering preserves compatible mixed geography', async () => {
  const provider = {
    id: 'ashby',
    async fetch() {
      return [job('mixed', 'Remote (Europe or US)')];
    },
  };
  const result = await runTrackedScan({
    portalConfig: portalConfig(),
    targets: [target(provider)],
    providers: new Map([['ashby', provider]]),
    policy: policy(),
    concurrency: 1,
    maxCandidates: 10,
    upstreamRef: 'test-ref',
  });
  assert.equal(result.candidates.length, 1);
});
