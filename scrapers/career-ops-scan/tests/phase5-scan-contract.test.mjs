import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDiscoveryPolicy } from '../src/policy/discovery-policy.mjs';
import { candidateFromJob, runTrackedScan } from '../src/scan/tracked-source.mjs';

test('candidate records acquisition tenant, origin, and pinned provider source', () => {
  const source = Object.freeze({
    repository: 'santifer/career-ops',
    file: 'providers/personio.mjs',
    ref: 'abc123',
    license: 'MIT',
    changes: ['adapted'],
  });
  const capabilities = Object.freeze({
    listDescription: true,
    detail: false,
    importReady: true,
    providerDateFilter: false,
  });
  const candidate = candidateFromJob(
    {
      id: '42',
      title: 'Product Manager',
      url: 'https://acme.jobs.personio.de/job/42',
      company: 'Acme',
      location: 'Berlin',
      description: 'Role',
      acquisitionMode: 'csb-public-tiles',
    },
    {
      provider: 'personio',
      tenant: 'acme',
      name: 'Acme',
      careers_url: 'https://brand.example/jobs',
      sourceOrigin: 'https://acme.jobs.personio.de',
      targetClass: 'priority',
      reason: 'tracked_company',
      _provider: { id: 'personio', source, capabilities },
    },
    'legacy-ref',
  );
  assert.equal(candidate.sourceProvider, 'personio');
  assert.equal(candidate.sourceTenant, 'acme');
  assert.equal(candidate.provenance.sourceOrigin, 'https://acme.jobs.personio.de');
  assert.equal(candidate.provenance.acquisitionMode, 'csb-public-tiles');
  assert.deepEqual(candidate.provenance.providerImplementation, {
    repository: source.repository,
    file: source.file,
    ref: source.ref,
    license: source.license,
  });
  assert.equal('providerCapabilities' in candidate.provenance, false);
  assert.equal(candidate.foundOn, 'career-ops-scan');
});


test('health-only canary bypasses candidate filters and preserves partial jobs for detail sampling', async () => {
  const source = Object.freeze({
    repository: 'santifer/career-ops',
    file: 'providers/successfactors.mjs',
    ref: 'abc123',
    license: 'MIT',
  });
  const jobs = Array.from({ length: 5 }, (_, index) => ({
    id: String(index + 1),
    title: `Unrelated role ${index + 1}`,
    company: 'Canary Company',
    location: 'Nowhere',
    url: `https://canary.jobs.hr.cloud.sap/job/unrelated/${index + 1}-en_US`,
  }));
  const provider = {
    id: 'successfactors',
    source,
    async fetch(_target, ctx) {
      ctx.reportProviderTelemetry({
        acquisitionMode: 'csb-api',
        listingOutcome: 'listing_success_nonempty',
        explicitTotal: jobs.length,
      });
      return jobs;
    },
  };
  const target = {
    sequence: 0,
    provider: 'successfactors',
    providerVariant: 'csb',
    healthPartition: 'successfactors:csb',
    tenant: 'canary.jobs.hr.cloud.sap',
    name: 'CSB canary',
    careers_url: 'https://canary.jobs.hr.cloud.sap/',
    sourceOrigin: 'https://canary.jobs.hr.cloud.sap',
    targetClass: 'priority',
    reason: 'provider_canary',
    healthOnly: true,
    canary: {
      minimumJobs: 10,
      detailSampleSize: 3,
      minimumDetailSuccesses: 1,
      intervalHours: 24,
    },
    _provider: provider,
  };
  const policy = parseDiscoveryPolicy({
    schema_version: 1,
    defaults: {
      execution: {
        concurrency: 1,
        min_request_interval_ms: 0,
      },
    },
    providers: {
      ashby: { catalog_enabled: false },
      successfactors: {},
    },
  });
  const result = await runTrackedScan({
    portalConfig: {
      title_filter: {
        positive: ['This will never match'],
        negative: [],
      },
    },
    targets: [target],
    providers: new Map([['successfactors', provider]]),
    policy,
    concurrency: 1,
    maxCandidates: 10,
    upstreamRef: 'legacy-ref',
    httpContextFactory: () => ({}),
  });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.canaryCandidates.length, 3);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.providerResults[0].status, 'error');
  assert.equal(result.providerResults[0].errorClass, 'provider_anomaly');
  assert.equal(result.providerResults[0].jobsReturned, 5);
});

test('tracked target can share one fetch with an attached canary', async () => {
  const jobs = [{
    id: '1',
    title: 'Engineering Manager',
    company: 'Canary Company',
    location: 'Berlin',
    url: 'https://canary.jobs.hr.cloud.sap/job/engineering-manager/1-en_US',
  }];
  const provider = {
    id: 'successfactors',
    source: {
      repository: 'santifer/career-ops',
      file: 'providers/successfactors.mjs',
      ref: 'abc123',
      license: 'MIT',
    },
    async fetch(_target, ctx) {
      ctx.reportProviderTelemetry({
        acquisitionMode: 'csb-api',
        listingOutcome: 'listing_success_nonempty',
        explicitTotal: 1,
      });
      return jobs;
    },
  };
  const target = {
    sequence: 0,
    provider: 'successfactors',
    providerVariant: 'csb',
    healthPartition: 'successfactors:csb',
    tenant: 'canary.jobs.hr.cloud.sap',
    name: 'Tracked plus canary',
    careers_url: 'https://canary.jobs.hr.cloud.sap/',
    sourceOrigin: 'https://canary.jobs.hr.cloud.sap',
    targetClass: 'priority',
    reason: 'tracked_company',
    healthOnly: false,
    canaryAttached: true,
    canary: {
      minimumJobs: 1,
      detailSampleSize: 1,
      minimumDetailSuccesses: 1,
      intervalHours: 24,
    },
    _provider: provider,
  };
  const policy = parseDiscoveryPolicy({
    schema_version: 1,
    defaults: { execution: { concurrency: 1, min_request_interval_ms: 0 } },
    providers: { ashby: { catalog_enabled: false }, successfactors: {} },
  });
  const result = await runTrackedScan({
    portalConfig: {
      title_filter: { positive: ['Engineering Manager'], negative: [] },
      location_filter: { always_allow: ['Berlin'] },
    },
    targets: [target],
    providers: new Map([['successfactors', provider]]),
    policy,
    concurrency: 1,
    maxCandidates: 10,
    upstreamRef: 'legacy-ref',
    httpContextFactory: () => ({}),
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.canaryCandidates.length, 1);
  assert.equal(result.providerResults[0].status, 'ok');
  assert.equal(result.providerResults[0].jobsReturned, 1);
});
