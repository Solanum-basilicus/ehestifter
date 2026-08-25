import test from 'node:test';
import assert from 'node:assert/strict';

import icims, {
  parseIcimsSearchPage,
  resolveIcimsOrigin,
} from '../src/providers/icims.mjs';

function card(id, title, location = 'Berlin, Germany', href = null) {
  return `<div class="iCIMS_JobCardItem">
    <h3>${title}</h3>
    <span class="field-label">Location</span><span>${location}</span>
    <a href="${href ?? `/jobs/${id}/role-${id}/job`}">View</a>
  </div>`;
}

test('iCIMS requires a tenant portal host and keeps the full host as tenant', () => {
  const entry = { careers_url: 'https://careers-rambus.icims.com/jobs/search' };
  assert.equal(resolveIcimsOrigin(entry), 'https://careers-rambus.icims.com');
  assert.equal(icims.tenant(entry), 'careers-rambus.icims.com');
  assert.equal(resolveIcimsOrigin({ careers_url: 'https://www.icims.com/jobs' }), null);
  assert.equal(resolveIcimsOrigin({ careers_url: 'http://careers-rambus.icims.com/jobs' }), null);
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

test('iCIMS fetch honors the smaller page cap and uses browser headers', async () => {
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
        return card('23020', 'Engineer');
      },
    },
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/jobs\/search\?ss=1&pr=0&in_iframe=1$/);
  assert.match(calls[0].options.headers['user-agent'], /Mozilla/);
  assert.equal(jobs.length, 1);
});

test('iCIMS fetch stops when the first job repeats on the next page', async () => {
  let calls = 0;
  const jobs = await icims.fetch(
    { name: 'Rambus', careers_url: 'https://careers-rambus.icims.com', max_pages: 3 },
    {
      async sleep() {},
      async fetchText() {
        calls += 1;
        return card('23020', 'Engineer');
      },
    },
  );
  assert.equal(calls, 2);
  assert.equal(jobs.length, 1);
});
