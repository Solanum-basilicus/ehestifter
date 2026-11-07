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

const WIDGET_ADJACENT_HTML = `
<div class="job-list-content" data-job-id="201">
  <div><span class="location-view-item">Berlin</span></div>
  <a class="job-title" href="/job/201/engineer">Engineer</a>
</div>
<div class="job-list-content">
  <a class="job-title" href="/job/202/sales">Sales</a>
  <span class="location-view-item">Hamburg</span>
</div>
<div class="job-list-content" data-job-id="203">
  <a class="job-title" href="/job/203/designer">Designer</a>
  <div><span class="location-view-item">Munich</span></div>
</div>`;

const VACANCIES_LIST_HTML = `
<ul>
  <li>
    <a href="/job/301/engineer">Engineer</a>
    <span class="location-view-item">Berlin</span>
    <span class="location-view-item">Potsdam</span>
  </li>
  <li>
    <a href="/job/302/designer">Designer</a>
    <span class="location-view-item">Munich</span>
  </li>
</ul>`;

test('Softgarden widget keeps each location inside its job element', () => {
  const jobs = parseSoftgardenWidget(
    WIDGET_ADJACENT_HTML,
    'https://acme.softgarden.io/de/widgets/jobs',
  );
  assert.deepEqual(jobs.map(({ id, location }) => ({ id, location })), [
    { id: '201', location: 'Berlin' },
    { id: '203', location: 'Munich' },
  ]);
});

test('Softgarden widget keeps multiple valid locations in nested elements', () => {
  const jobs = parseSoftgardenWidget(`
    <article data-job-id='401'>
      <a href="/job/401/consultant">Consultant</a>
      <div><span class="location-view-item">Berlin</span></div>
      <div><span class="location-view-item">Hamburg</span></div>
      <div><span class="location-view-item">Berlin</span></div>
    </article>`, 'https://acme.softgarden.io/de/widgets/jobs');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].location, 'Berlin / Hamburg');
});

test('Softgarden widget recovers the job link from an unclosed container without locations', () => {
  const jobs = parseSoftgardenWidget(`
    <div data-job-id="501"><a href="/job/501/first">First</a>
      <span class="location-view-item">Berlin</span>
    <div class="job-list-content"><a href="/job/502/second">Second</a>
      <span class="location-view-item">Hamburg</span></div>
  `, 'https://acme.softgarden.io/de/widgets/jobs');
  assert.deepEqual(jobs.map(({ id, location }) => ({ id, location })), [
    { id: '501', location: '' },
    { id: '502', location: '' },
  ]);
});

test('Softgarden widget recovers mixed job links without joining their locations', () => {
  const jobs = parseSoftgardenWidget(`
    <div data-job-id="601">
      <a href="/job/601/first">First</a>
      <span class="location-view-item">Berlin</span>
      <a href="/job/602/second">Second</a>
      <span class="location-view-item">Hamburg</span>
    </div>`, 'https://acme.softgarden.io/de/widgets/jobs');
  assert.deepEqual(jobs.map(({ id, location }) => ({ id, location })), [
    { id: '601', location: '' },
    { id: '602', location: '' },
  ]);
});

test('Softgarden vacancies fallback keeps list item locations separate', () => {
  const jobs = parseSoftgardenVacanciesPage(
    VACANCIES_LIST_HTML,
    'https://acme.softgarden.io/de/vacancies',
  );
  assert.deepEqual(jobs.map(({ id, location }) => ({ id, location })), [
    { id: '301', location: 'Berlin / Potsdam' },
    { id: '302', location: 'Munich' },
  ]);
});

test('Softgarden vacancies fallback keeps article locations separate', () => {
  const jobs = parseSoftgardenVacanciesPage(`
    <article><a href="/job/701/first">First</a>
      <span class="job-location">Dresden</span></article>
    <article><a href="/job/702/second">Second</a>
      <span class="job-location">Bremen</span></article>`,
  'https://acme.softgarden.io/de/vacancies');
  assert.deepEqual(jobs.map(({ id, location }) => ({ id, location })), [
    { id: '701', location: 'Dresden' },
    { id: '702', location: 'Bremen' },
  ]);
});

test('Softgarden vacancies fallback keeps ungrouped jobs but drops uncertain locations', () => {
  const jobs = parseSoftgardenVacanciesPage(`
    <a href="/job/801/first">First</a>
    <span class="location-view-item">Berlin</span>
    <a href="/job/802/second">Second</a>
    <span class="location-view-item">Hamburg</span>`,
  'https://acme.softgarden.io/de/vacancies');
  assert.deepEqual(jobs.map(({ id, location }) => ({ id, location })), [
    { id: '801', location: '' },
    { id: '802', location: '' },
  ]);
});

test('Softgarden fetch reports the vacancies-page path', async () => {
  const telemetry = [];
  const jobs = await softgarden.fetch(
    { name: 'Acme', careers_url: 'https://acme.softgarden.io/de/vacancies' },
    {
      reportProviderTelemetry(value) { telemetry.push(value); },
      async fetchText() { return VACANCIES_HTML; },
    },
  );
  assert.equal(jobs.length, 2);
  assert.deepEqual(telemetry, [{ acquisitionMode: 'vacancies-page' }]);
});

test('Softgarden fetch reports widget fallback and keeps job boundaries', async () => {
  const telemetry = [];
  const calls = [];
  const jobs = await softgarden.fetch(
    { name: 'Acme', careers_url: 'https://acme.softgarden.io/de/vacancies' },
    {
      reportProviderTelemetry(value) { telemetry.push(value); },
      async fetchText(url) {
        calls.push(String(url));
        return calls.length === 1 ? '<html>No jobs</html>' : WIDGET_ADJACENT_HTML;
      },
    },
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(jobs.map(({ id, location }) => ({ id, location })), [
    { id: '201', location: 'Berlin' },
    { id: '203', location: 'Munich' },
  ]);
  assert.deepEqual(telemetry, [{ acquisitionMode: 'legacy-widget' }]);
});

test('Softgarden reports a listing error when no link has a usable title', async () => {
  const telemetry = [];
  await assert.rejects(
    () => softgarden.fetch(
      { name: 'Acme', careers_url: 'https://acme.softgarden.io/de/vacancies' },
      {
        reportProviderTelemetry(value) { telemetry.push(value); },
        async fetchText(url) {
          return String(url).includes('widgets/jobs')
            ? '<html>Empty widget</html>'
            : '<a href="/job/801/first"><span></span></a>';
        },
      },
    ),
    /listing_schema_mismatch/,
  );
  assert.deepEqual(telemetry, [{ acquisitionMode: 'legacy-widget' }]);
});


test('Softgarden widget recovers job links when no complete block exists', async () => {
  const telemetry = [];
  const jobs = await softgarden.fetch(
    { name: 'Acme', api: 'https://acme.softgarden.io/de/widgets/jobs' },
    {
      reportProviderTelemetry(value) { telemetry.push(value); },
      async fetchText() {
        return '<div data-job-id="901"><a href="/job/901/first">First</a>';
      },
    },
  );
  assert.deepEqual(jobs.map(({ id, location }) => ({ id, location })), [
    { id: '901', location: '' },
  ]);
  assert.deepEqual(telemetry, [
    { acquisitionMode: 'legacy-widget' },
    { acquisitionMode: 'legacy-widget-anchors' },
  ]);
});


test('Softgarden widget keeps a large valid location list', () => {
  const locations = Array.from({ length: 80 }, (_, index) => `Site ${index + 1}`);
  const html = `<div data-job-id="1001">
    <a href='/job/1001/field-role'>Field role</a>
    ${locations.map((location) => `<span class='location-view-item'>${location}</span>`).join('')}
  </div>`;
  const jobs = parseSoftgardenWidget(html, 'https://acme.softgarden.io/de/widgets/jobs');
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].location.split(' / '), locations);
});

test('Softgarden widget ignores job markup in comments and scripts', () => {
  const html = `<!-- <div data-job-id="2001"><a href="/job/2001/fake">Fake</a></div> -->
    <script>const fake = '<div data-job-id="2002"><a href="/job/2002/fake">Fake</a></div>';</script>
    <div data-job-id="2003">
      <a href="/job/2003/real">Real</a>
      <span class="location-view-item">Berlin</span>
    </div>`;
  const jobs = parseSoftgardenWidget(html, 'https://acme.softgarden.io/de/widgets/jobs');
  assert.deepEqual(jobs.map(({ id, location }) => ({ id, location })), [
    { id: '2003', location: 'Berlin' },
  ]);
});

// Representative markup for a board that uses div cards instead of table rows.
// This is a reconstructed fixture, not a captured provider response.
test('Softgarden fetch recovers valid listing links from a div-only board', async () => {
  let calls = 0;
  const telemetry = [];
  const jobs = await softgarden.fetch(
    { name: 'NECT', careers_url: 'https://nect.softgarden.io/en/vacancies' },
    {
      reportProviderTelemetry(value) { telemetry.push(value); },
      async fetchText() {
        calls += 1;
        return `<section class="vacancies">
          <div class="vacancy"><a href="/job/64378008/partner-manager">Partner Manager</a>
            <span class="location-view-item">Hamburg</span></div>
          <div class="vacancy"><a href="/job/64716454/engineer">Engineer</a>
            <span class="location-view-item">Berlin</span></div>
        </section>`;
      },
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(jobs.map(({ id, location }) => ({ id, location })), [
    { id: '64378008', location: '' },
    { id: '64716454', location: '' },
  ]);
  assert.deepEqual(telemetry, [{ acquisitionMode: 'vacancies-page-anchors' }]);
});

test('Softgarden anchor recovery skips scripts, foreign links, and duplicate ids', () => {
  const html = `<script><a href="/job/100/false">False</a></script>
    <!-- <a href="/job/101/false">False</a> -->
    <a href="https://example.org/job/102/foreign">Foreign</a>
    <div><a href="/job/103/first">First</a></div>
    <div><a href="/job/103/duplicate">Duplicate</a></div>
    <div><a href="/job/104/second">Second</a></div>`;
  const jobs = parseSoftgardenVacanciesPage(html, 'https://nect.softgarden.io/en/vacancies');
  assert.deepEqual(jobs.map(({ id, location }) => ({ id, location })), [
    { id: '103', location: '' },
    { id: '104', location: '' },
  ]);
});

test('Softgarden empty widget with job-like text still reports a schema mismatch', async () => {
  await assert.rejects(() => softgarden.fetch(
    { name: 'Acme', api: 'https://acme.softgarden.io/en/widgets/jobs' },
    { async fetchText() { return '<p>See /job/901/ later</p>'; } },
  ), /widget_schema_mismatch/);
});
