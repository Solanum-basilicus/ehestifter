import test from 'node:test';
import assert from 'node:assert/strict';

import softgarden, {
  parseSoftgardenDate,
  parseSoftgardenVacanciesPage,
  parseSoftgardenWidget,
  resolveSoftgardenWidget,
} from '../src/providers/softgarden.mjs';



const VACANCIES_HTML = `
<table>
  <tr>
    <td>7/17/26</td>
    <td><a href="/job/64378008/Partner-Manager-International-all-genders-">Partner Manager International (all genders)</a></td>
    <td>Experienced Professional</td>
    <td>Sales &amp; Key Account Management</td>
    <td>Hamburg</td>
  </tr>
  <tr>
    <td>7/13/26</td>
    <td><a href="/job/64716454/Engineering-Manager-Lead-Developer-for-Engineering-all-genders-">Engineering Manager/Lead Developer</a></td>
    <td>Leadership Role</td>
    <td>Product &amp; Technology</td>
    <td>Hamburg</td>
  </tr>
</table>`;

const HTML = `
<div class="job-list-content" data-job-id="123">
  <div class="matchValue date">04.07.26</div>
  <a class="job-title" href="../../job/123/senior-product-manager">Senior &amp; Product Manager</a>
  <span class="location-view-item">Berlin</span>
  <span class="location-view-item">Remote</span>
</div>
<div class="job-list-content" data-job-id="123">
  <a href="../../job/123/duplicate">Duplicate</a>
</div>
<div class="job-list-content" data-job-id="124">
  <a href="../../job/124/engineering-manager">Engineering Manager</a>
  <span class="location-view-item">Munich</span>
</div>`;

test('Softgarden resolves explicit widgets and defaults to German widget', () => {
  assert.equal(
    resolveSoftgardenWidget({ careers_url: 'https://acme.softgarden.io/en' }).href,
    'https://acme.softgarden.io/en/widgets/jobs',
  );
  assert.equal(
    resolveSoftgardenWidget({ api: 'https://acme.softgarden.io/de/widgets/jobs/' }).href,
    'https://acme.softgarden.io/de/widgets/jobs',
  );
  assert.equal(resolveSoftgardenWidget({ careers_url: 'http://acme.softgarden.io' }), null);
  assert.equal(resolveSoftgardenWidget({ careers_url: 'https://softgarden.example' }), null);
});

test('Softgarden date parsing validates calendar dates', () => {
  assert.equal(parseSoftgardenDate('04.07.26'), Date.UTC(2026, 6, 4));
  assert.equal(parseSoftgardenDate('7/4/26'), Date.UTC(2026, 6, 4));
  assert.equal(parseSoftgardenDate('31.02.26'), undefined);
});

test('Softgarden current vacancies parser reads table rows and stable job ids', () => {
  const jobs = parseSoftgardenVacanciesPage(
    VACANCIES_HTML,
    'https://nect.softgarden.io/en/vacancies',
  );
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].id, '64378008');
  assert.equal(jobs[0].title, 'Partner Manager International (all genders)');
  assert.equal(jobs[0].location, 'Hamburg');
  assert.equal(jobs[0].postedAt, Date.UTC(2026, 6, 17));
  assert.equal(
    jobs[1].url,
    'https://nect.softgarden.io/job/64716454/Engineering-Manager-Lead-Developer-for-Engineering-all-genders-',
  );
});

test('Softgarden current vacancies parser rejects cross-origin links', () => {
  assert.deepEqual(
    parseSoftgardenVacanciesPage(
      '<table><tr><td><a href="https://evil.example/job/1/a">PM</a></td></tr></table>',
      'https://nect.softgarden.io/en/vacancies',
    ),
    [],
  );
});

test('Softgarden widget parser extracts and deduplicates jobs', () => {
  const jobs = parseSoftgardenWidget(
    HTML,
    new URL('https://acme.softgarden.io/de/widgets/jobs'),
  );
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].id, '123');
  assert.equal(jobs[0].title, 'Senior & Product Manager');
  assert.equal(jobs[0].location, 'Berlin / Remote');
  assert.equal(jobs[0].url, 'https://acme.softgarden.io/job/123/senior-product-manager');
  assert.equal(jobs[0].postedAt, Date.UTC(2026, 6, 4));
});

test('Softgarden parser rejects cross-origin job links', () => {
  const jobs = parseSoftgardenWidget(
    '<div data-job-id="1"><a href="https://evil.example/job/1">PM</a></div>',
    'https://acme.softgarden.io/de/widgets/jobs',
  );
  assert.deepEqual(jobs, []);
});

test('Softgarden fetch prefers the current vacancies page and applies company name', async () => {
  const calls = [];
  const jobs = await softgarden.fetch(
    { name: 'NECT', careers_url: 'https://nect.softgarden.io/en/vacancies' },
    {
      async fetchText(url) {
        calls.push(String(url));
        return VACANCIES_HTML;
      },
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].company, 'NECT');
  assert.equal(softgarden.tenant({ careers_url: 'https://nect.softgarden.io' }), 'nect');
});

test('Softgarden fetch falls back to the legacy widget', async () => {
  const calls = [];
  const jobs = await softgarden.fetch(
    { name: 'Acme', careers_url: 'https://acme.softgarden.io/de' },
    {
      async fetchText(url) {
        calls.push(String(url));
        return calls.length === 1 ? '<html>No job links</html>' : HTML;
      },
    },
  );
  assert.equal(calls.length, 2);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].company, 'Acme');
});

test('Softgarden does not report a healthy empty board when job links are present', async () => {
  await assert.rejects(
    () => softgarden.fetch(
      { name: 'Acme', careers_url: 'https://acme.softgarden.io/en/vacancies' },
      {
        async fetchText(url) {
          return String(url).includes('/widgets/jobs')
            ? '<html>changed widget</html>'
            : '<a href="/job/123/"><span></span></a>';
        },
      },
    ),
    /listing_schema_mismatch/,
  );
});

test('Softgarden page transport failure still allows legacy widget fallback', async () => {
  let calls = 0;
  const jobs = await softgarden.fetch(
    { name: 'Acme', careers_url: 'https://acme.softgarden.io/en/vacancies' },
    {
      async fetchText(url) {
        calls += 1;
        if (!String(url).includes('/widgets/jobs')) throw new Error('page unavailable');
        return HTML;
      },
    },
  );
  assert.equal(calls, 2);
  assert.equal(jobs.length, 2);
});
