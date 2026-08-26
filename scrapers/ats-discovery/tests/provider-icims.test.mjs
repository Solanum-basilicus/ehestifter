import test from 'node:test';
import assert from 'node:assert/strict';

import icims, {
  parseIcimsSearchPage,
  resolveIcimsNextPageUrl,
  resolveIcimsOrigin,
  resolveIcimsSearchUrl,
} from '../src/providers/icims.mjs';

function card(id, title, location = 'Berlin, Germany', href = null) {
  return `<div class="iCIMS_JobCardItem">
    <h3>${title}</h3>
    <span class="field-label">Location</span><span>${location}</span>
    <a href="${href ?? `/jobs/${id}/role-${id}/job`}">View</a>
  </div>`;
}

function intro(searchHref = '/jobs/search?hashed=-435708792&amp;ss=1') {
  return `<main><a href="${searchHref}">view all open job positions</a></main>`;
}

function nextPage(page) {
  return `<nav><a href="/jobs/search?o=&amp;pr=${page}&amp;schemaId=">Page ${page + 1}</a></nav>`;
}

test('iCIMS requires a tenant portal host and keeps the full host as tenant', () => {
  const entry = { careers_url: 'https://careers-rambus.icims.com/jobs/search' };
  assert.equal(resolveIcimsOrigin(entry), 'https://careers-rambus.icims.com');
  assert.equal(icims.tenant(entry), 'careers-rambus.icims.com');
  assert.equal(resolveIcimsOrigin({ careers_url: 'https://www.icims.com/jobs' }), null);
  assert.equal(resolveIcimsOrigin({ careers_url: 'http://careers-rambus.icims.com/jobs' }), null);
});

test('iCIMS bootstrap keeps the tenant-generated hashed search URL', () => {
  const origin = 'https://careers-rambus.icims.com';
  assert.equal(
    resolveIcimsSearchUrl(intro(), origin),
    `${origin}/jobs/search?hashed=-435708792&ss=1`,
  );
});

test('iCIMS bootstrap and pagination reject foreign search URLs', () => {
  const origin = 'https://careers-rambus.icims.com';
  assert.equal(
    resolveIcimsSearchUrl(intro('https://other.icims.com/jobs/search?ss=1'), origin),
    null,
  );
  assert.equal(
    resolveIcimsNextPageUrl(
      '<a href="https://other.icims.com/jobs/search?pr=1">Page 2</a>',
      origin,
      0,
    ),
    null,
  );
});

test('iCIMS pagination follows the next page emitted by the portal', () => {
  const origin = 'https://careers-rambus.icims.com';
  assert.equal(
    resolveIcimsNextPageUrl(nextPage(1), origin, 0),
    `${origin}/jobs/search?o=&pr=1&schemaId=`,
  );
  assert.equal(resolveIcimsNextPageUrl(nextPage(2), origin, 0), null);
});

test('iCIMS parser accepts same-origin numeric jobs and ignores foreign links', () => {
  const origin = 'https://careers-rambus.icims.com';
  const jobs = parseIcimsSearchPage(
    card('23020', 'Senior &amp; Staff Engineer')
      + card('23021', 'Foreign', 'Remote', 'https://other.icims.com/jobs/23021/role/job')
      + card('23020', 'Duplicate'),
    origin,
    'Rambus',
  );

  assert.deepEqual(jobs, [{
    id: '23020',
    title: 'Senior & Staff Engineer',
    url: `${origin}/jobs/23020/role-23020/job`,
    company: 'Rambus',
    location: 'Berlin, Germany',
  }]);
});

test('iCIMS fetch bootstraps the first page and honors the smaller page cap', async () => {
  const calls = [];
  const jobs = await icims.fetch(
    {
      name: 'Rambus',
      careers_url: 'https://careers-rambus.icims.com',
      max_pages: 10,
    },
    {
      maxPages: 1,
      async fetchText(url, options) {
        calls.push({ url: String(url), options });
        if (calls.length === 1) return intro();
        return card('23020', 'Engineer') + nextPage(1);
      },
    },
  );

  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].url,
    'https://careers-rambus.icims.com/jobs/intro?mobile=true&needsRedirect=false',
  );
  assert.equal(
    calls[1].url,
    'https://careers-rambus.icims.com/jobs/search?hashed=-435708792&ss=1',
  );
  assert.match(calls[0].options.headers['user-agent'], /Mozilla/);
  assert.match(calls[1].options.headers['user-agent'], /Mozilla/);
  assert.equal(
    calls[1].options.headers.referer,
    'https://careers-rambus.icims.com/jobs/intro?mobile=true&needsRedirect=false',
  );
  assert.equal(jobs.length, 1);
});

test('iCIMS fetch follows portal pagination and deduplicates provider ids', async () => {
  const calls = [];
  const jobs = await icims.fetch(
    { name: 'Rambus', careers_url: 'https://careers-rambus.icims.com', max_pages: 3 },
    {
      async sleep() {},
      async fetchText(url) {
        calls.push(String(url));
        if (calls.length === 1) return intro();
        if (calls.length === 2) {
          return card('23020', 'Engineer') + nextPage(1);
        }
        return card('23020', 'Engineer') + card('23021', 'Staff Engineer');
      },
    },
  );

  assert.deepEqual(calls, [
    'https://careers-rambus.icims.com/jobs/intro?mobile=true&needsRedirect=false',
    'https://careers-rambus.icims.com/jobs/search?hashed=-435708792&ss=1',
    'https://careers-rambus.icims.com/jobs/search?o=&pr=1&schemaId=',
  ]);
  assert.deepEqual(jobs.map((job) => job.id), ['23020', '23021']);
});

test('iCIMS fetch fails closed when bootstrap has no same-origin search link', async () => {
  await assert.rejects(
    icims.fetch(
      { name: 'Rambus', careers_url: 'https://careers-rambus.icims.com' },
      { async fetchText() { return '<html>No job search link</html>'; } },
    ),
    /portal intro has no same-origin job search link/,
  );
});
