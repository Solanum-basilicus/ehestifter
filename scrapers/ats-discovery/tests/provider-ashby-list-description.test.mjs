import test from 'node:test';
import assert from 'node:assert/strict';

import ashby from '../src/providers/ashby.mjs';

test('Ashby list acquisition keeps the public board description and identifiers', async () => {
  const jobs = await ashby.fetch(
    { name: 'Acme', careers_url: 'https://jobs.ashbyhq.com/acme' },
    {
      async fetchJson() {
        return {
          jobs: [{
            id: 'job-1',
            title: 'Product Manager',
            jobUrl: 'https://jobs.ashbyhq.com/acme/job-1',
            applyUrl: 'https://jobs.ashbyhq.com/acme/job-1/application',
            location: 'Berlin',
            descriptionPlain: 'Full list description.',
            publishedAt: '2026-10-01T12:00:00Z',
          }],
        };
      },
    },
  );

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, 'job-1');
  assert.equal(jobs[0].description, 'Full list description.');
  assert.equal(jobs[0].applyUrl, 'https://jobs.ashbyhq.com/acme/job-1/application');
  assert.equal(jobs[0].acquisitionMode, 'ashby-list-api');
});

test('Ashby list HTML description is normalized when plain text is absent', async () => {
  const [job] = await ashby.fetch(
    { name: 'Acme', careers_url: 'https://jobs.ashbyhq.com/acme' },
    {
      async fetchJson() {
        return {
          jobs: [{
            id: 'job-2',
            title: 'Product Manager',
            jobUrl: 'https://jobs.ashbyhq.com/acme/job-2',
            descriptionHtml: '<p>Own <strong>product</strong> strategy.</p>',
          }],
        };
      },
    },
  );
  assert.equal(job.description, 'Own product strategy.');
});
