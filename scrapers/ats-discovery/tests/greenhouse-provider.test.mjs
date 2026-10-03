import test from 'node:test';
import assert from 'node:assert/strict';

import greenhouse from '../src/providers/greenhouse.mjs';

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

test('Greenhouse native id stays provenance and does not enable explicit identity', async () => {
  const [{ candidateFromJob }, { default: provider }] = await Promise.all([
    import('../src/scan/tracked-source.mjs'),
    import('../src/providers/greenhouse.mjs'),
  ]);
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
    _provider: provider,
  }, 'legacy-ref');

  assert.equal(candidate.provenance.providerNativeId, '123456');
  assert.equal(candidate.explicitIdentity, null);
  assert.equal(candidate.canonicalIdentity, null);
});
