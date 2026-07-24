import test from 'node:test';
import assert from 'node:assert/strict';

import smartrecruiters, {
  parseSmartRecruitersResponse,
  resolveSmartRecruitersTenant,
} from '../src/providers/smartrecruiters.mjs';

function response(count, offset = 0) {
  return {
    content: Array.from({ length: count }, (_, index) => ({
      id: `id-${offset + index}`,
      name: `Product Manager ${offset + index}`,
      ref: `https://api.smartrecruiters.com/v1/companies/Acme/postings/id-${offset + index}`,
      releasedDate: '2026-07-01T00:00:00Z',
      location: {
        city: 'Berlin',
        country: 'Germany',
        remote: index === 0,
      },
    })),
  };
}

test('SmartRecruiters resolves tenant from careers and jobs hosts', () => {
  assert.equal(
    resolveSmartRecruitersTenant({ careers_url: 'https://careers.smartrecruiters.com/Acme/jobs' }),
    'Acme',
  );
  assert.equal(
    resolveSmartRecruitersTenant({ api: 'https://jobs.smartrecruiters.com/Brand' }),
    'Brand',
  );
  assert.equal(resolveSmartRecruitersTenant({ careers_url: 'https://brand.example/jobs' }), null);
});

test('SmartRecruiters parser rewrites API refs to public URLs', () => {
  const [job] = parseSmartRecruitersResponse(response(1), 'Acme GmbH', 'FallbackTenant');
  assert.equal(
    job.url,
    'https://jobs.smartrecruiters.com/Acme/id-0-product-manager-0',
  );
  assert.equal(job.location, 'Berlin, Germany, Remote');
  assert.equal(job.postedAt, Date.parse('2026-07-01T00:00:00Z'));
});

test('SmartRecruiters fallback URL uses the configured tenant, not company name', () => {
  const [job] = parseSmartRecruitersResponse({
    content: [{ id: '42', name: 'Engineering Manager', location: {} }],
  }, 'Human Friendly Company', 'ExactTenant');
  assert.equal(
    job.url,
    'https://jobs.smartrecruiters.com/ExactTenant/42-engineering-manager',
  );
});

test('SmartRecruiters paginates by raw page fullness and stops on short page', async () => {
  const urls = [];
  const jobs = await smartrecruiters.fetch(
    {
      name: 'Acme',
      careers_url: 'https://careers.smartrecruiters.com/Acme',
      max_pages: 3,
    },
    {
      async fetchJson(url) {
        urls.push(String(url));
        return urls.length === 1 ? response(100) : response(2, 100);
      },
    },
  );
  assert.equal(urls.length, 2);
  assert.match(urls[1], /offset=100/);
  assert.equal(jobs.length, 102);
});

test('SmartRecruiters honors the smaller context page cap', async () => {
  let calls = 0;
  const jobs = await smartrecruiters.fetch(
    { name: 'Acme', careers_url: 'https://jobs.smartrecruiters.com/Acme', max_pages: 10 },
    { maxPages: 1, async fetchJson() { calls += 1; return response(100); } },
  );
  assert.equal(calls, 1);
  assert.equal(jobs.length, 100);
});

test('SmartRecruiters fetch deduplicates overlapping pages by posting id', async () => {
  let calls = 0;
  const first = response(100);
  const second = {
    content: [first.content[99], {
      id: 'new-id',
      name: 'New Product Manager',
      location: {},
    }],
  };
  const jobs = await smartrecruiters.fetch(
    { name: 'Acme', careers_url: 'https://jobs.smartrecruiters.com/Acme', max_pages: 2 },
    { async fetchJson() { calls += 1; return calls === 1 ? first : second; } },
  );
  assert.equal(jobs.length, 101);
  assert.equal(jobs.filter((job) => job.id === 'id-99').length, 1);
});
