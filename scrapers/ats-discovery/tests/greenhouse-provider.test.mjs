import test from 'node:test';
import assert from 'node:assert/strict';

import greenhouse from '../src/providers/greenhouse.mjs';
import { preflightCandidates } from '../src/ehestifter/jobs-client.mjs';
import { candidateFromJob } from '../src/scan/tracked-source.mjs';

test('Greenhouse list preserves the native job id for detail provenance', async () => {
  const jobs = await greenhouse.fetch({
    name: 'Example',
    api: 'https://boards-api.greenhouse.io/v1/boards/example/jobs',
  }, {
    fetchJson: async () => ({
      jobs: [{
        id: 123456,
        title: 'Product Manager',
        absolute_url: 'https://careers.example.com/jobs/example?gh_jid=123456',
        location: { name: 'Berlin, Germany' },
        first_published: '2026-10-01T10:00:00Z',
      }],
    }),
  });

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, 123456);
  assert.equal(jobs[0].url, 'https://careers.example.com/jobs/example?gh_jid=123456');
});

test('Greenhouse native id is the explicit preflight identity', async () => {
  const job = {
    id: 123456,
    title: 'Product Manager',
    url: 'https://careers.example.com/jobs/example?gh_jid=123456',
    company: 'Example',
    location: 'Berlin, Germany',
  };
  const candidate = candidateFromJob(job, {
    sequence: 0,
    provider: 'greenhouse',
    tenant: 'example',
    name: 'Example',
    careers_url: 'https://job-boards.greenhouse.io/example',
    sourceOrigin: 'https://job-boards.greenhouse.io',
    targetClass: 'normal',
    reason: 'greenhouse_catalog',
    _provider: greenhouse,
  }, 'legacy-ref');

  assert.equal(candidate.provenance.providerNativeId, '123456');
  assert.deepEqual(candidate.explicitIdentity, {
    provider: 'greenhouse',
    providerTenant: 'example',
    externalId: '123456',
  });
  assert.equal(candidate.canonicalIdentity, null);
});

test('Greenhouse corporate URLs use distinct native identities during preflight', async () => {
  const jobs = [
    {
      id: 8721911002,
      title: 'Product Manager',
      url: 'https://www.workato.com/careers?gh_jid=8721911002#open-roles',
      company: 'Workato',
      location: 'Berlin, Germany',
    },
    {
      id: 8801509002,
      title: 'Senior Product Manager',
      url: 'https://www.workato.com/careers?gh_jid=8801509002#open-roles',
      company: 'Workato',
      location: 'Berlin, Germany',
    },
  ];
  const target = {
    sequence: 0,
    provider: 'greenhouse',
    tenant: 'workato',
    name: 'Workato',
    careers_url: 'https://job-boards.greenhouse.io/workato',
    sourceOrigin: 'https://job-boards.greenhouse.io',
    targetClass: 'normal',
    reason: 'greenhouse_catalog',
    _provider: greenhouse,
  };
  const candidates = jobs.map((job) => candidateFromJob(job, target, 'legacy-ref'));
  const calls = [];
  const client = {
    async existsByIdentity(identity) {
      calls.push({ method: 'identity', identity });
      return {
        exists: false,
        id: null,
        identity: { ...identity, identitySource: 'explicit' },
        urlInference: {
          foundOn: null,
          hiringCompanyName: null,
          postingCompanyName: null,
        },
      };
    },
    async existsByUrl(url) {
      calls.push({ method: 'url', url });
      throw new Error('Greenhouse URL preflight must not be used');
    },
  };

  const results = await preflightCandidates(candidates, client, 1);

  assert.deepEqual(calls, [
    {
      method: 'identity',
      identity: {
        provider: 'greenhouse',
        providerTenant: 'workato',
        externalId: '8721911002',
      },
    },
    {
      method: 'identity',
      identity: {
        provider: 'greenhouse',
        providerTenant: 'workato',
        externalId: '8801509002',
      },
    },
  ]);
  assert.equal(results[0].canonicalIdentity.externalId, '8721911002');
  assert.equal(results[1].canonicalIdentity.externalId, '8801509002');
});

test('Greenhouse derives tracked tenant from the board API', () => {
  assert.equal(greenhouse.tenant({
    name: 'Workato',
    careers_url: 'https://www.workato.com/careers',
    api: 'https://boards-api.greenhouse.io/v1/boards/workato/jobs',
  }), 'workato');
});

test('Greenhouse rejects a list row without a native job id', async () => {
  await assert.rejects(
    greenhouse.fetch({
      name: 'Example',
      api: 'https://boards-api.greenhouse.io/v1/boards/example/jobs',
    }, {
      fetchJson: async () => ({
        jobs: [{
          title: 'Product Manager',
          absolute_url: 'https://careers.example.com/jobs/example',
          location: { name: 'Berlin, Germany' },
        }],
      }),
    }),
    /job is missing native id/,
  );
});
