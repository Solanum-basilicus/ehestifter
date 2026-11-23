const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const template = fs.readFileSync(path.join(__dirname, '..', 'templates', 'job.html'), 'utf8');

function makePage({ fetchResponse } = {}) {
  const factories = new Map();
  const events = new Map();
  const context = {
    window: {
      __relativeFromLocal: (value) => `relative:${value}`,
      addEventListener(name, callback) { events.set(name, callback); },
    },
    fetch: fetchResponse,
    document: {
      addEventListener(name, callback) {
        if (name === 'alpine:init') callback();
      },
      getElementById() { return null; },
    },
    Alpine: { data(name, factory) { factories.set(name, factory); } },
  };
  const script = [...template.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .find((source) => source.includes("Alpine.data('jobDetailPage'"));
  assert.ok(script, 'Job detail code must exist');
  vm.runInNewContext(script, context, { filename: 'job.html' });
  return { page: factories.get('jobDetailPage')('job-1'), window: context.window, events };
}

test('job metadata keeps one link when original and apply URLs are equal', () => {
  const { page } = makePage();
  page.hydrateFromPayload({
    Url: ' https://jobs.example.test/open?ref=1 ',
    ApplyUrl: 'https://jobs.example.test/open?ref=1',
  });
  assert.equal(page.meta.url, page.meta.applyUrl);
  assert.equal(page.hasSeparateApplyUrl(), false);
});

test('job metadata keeps two destinations when their queries differ', () => {
  const { page } = makePage();
  page.hydrateFromPayload({
    Url: 'https://jobs.example.test/open?ref=1',
    ApplyUrl: 'https://jobs.example.test/open?ref=2',
  });
  assert.equal(page.hasSeparateApplyUrl(), true);
});

test('job metadata supports only one URL or no URLs', () => {
  const { page } = makePage();
  page.hydrateFromPayload({ Url: 'https://jobs.example.test/open' });
  assert.equal(page.hasSeparateApplyUrl(), false);
  page.hydrateFromPayload({ ApplyUrl: 'https://jobs.example.test/apply' });
  assert.equal(page.meta.url, '');
  assert.equal(page.hasSeparateApplyUrl(), true);
  page.hydrateFromPayload({});
  assert.equal(page.hasSeparateApplyUrl(), false);
});

test('job metadata keeps the last-seen and repost information', () => {
  const { page } = makePage();
  page.hydrateFromPayload({
    Title: 'An unabridged job title',
    FirstSeenAt: '2026-10-01',
    LastSeenAt: '2026-10-19',
    RepostCount: 2,
  });
  assert.equal(page.meta.title, 'An unabridged job title');
  assert.equal(page.seenPrefix(), 'Last seen');
  assert.equal(page.relativeSeen(), 'relative:2026-10-19');
  assert.equal(page.meta.repostCount, 2);
});

test('edit permission stays tied to creator and current user', () => {
  const { page, window } = makePage();
  window.CURRENT_USER_ID = 'user-1';
  page.hydrateFromPayload({ CreatedByUserId: 'user-2' });
  assert.equal(page.canEdit, false);
  page.hydrateFromPayload({ CreatedByUserId: 'user-1' });
  assert.equal(page.canEdit, true);
});

test('detail template uses a full title and compact metadata', () => {
  assert.match(template, /<h1 class="job-title" x-text="meta\.title"><\/h1>/);
  assert.doesNotMatch(template, /line-clamp-2|sticky-top|Copy job title|Copy company|@click="copy\(/);
  assert.match(template, /\.job-meta\s*\{[^}]*flex-wrap:wrap/);
  assert.match(template, /\.job-meta-links\s*\{[^}]*white-space:nowrap/);
  assert.match(template, /x-if="meta\.url \|\| meta\.applyUrl"/);
  assert.match(template, /x-if="!meta\.url && meta\.applyUrl"/);
  assert.match(template, /x-if="hasSeparateApplyUrl\(\) && meta\.url"/);
});

test('job actions use no column when edit is not available', () => {
  assert.match(template, /class="row-actions" :class="\{ 'with-job-actions': canEdit \}"/);
  assert.match(template, /class="card" x-cloak x-show="canEdit"/);
  assert.match(template, /\.row-actions\.with-job-actions\s*\{[^}]*grid-template-columns/);
  assert.match(template, /\.row-actions\s*\{[^}]*grid-template-columns:minmax\(0, 1fr\)/);
});


test('company application card stays in the right rail below compatibility', () => {
  const rail = template.indexOf('<!-- Right rail: Enrichers -->');
  const score = template.indexOf('id="compat-card"');
  const applications = template.indexOf('id="company-applications-card"');
  assert.ok(rail >= 0 && rail < score && score < applications);
  assert.match(template, /id="company-applications-card"[\s\S]*?🔒 Only you/);
  assert.match(template, /@click="loadCompanyApplications\(\)"/);
});

test('company application request starts only after job details succeed', async () => {
  let completeDetails;
  const urls = [];
  const { page, events } = makePage({
    fetchResponse: (url) => {
      urls.push(url);
      if (url === '/ui/jobs/job-1') return new Promise((resolve) => { completeDetails = resolve; });
      if (url.endsWith('/company-application-summary')) {
        return Promise.resolve({ ok: true, json: async () => ({
          available: true, companyName: 'Agency', last90Days: 1, last365Days: 4,
        }) });
      }
      throw new Error(`Unexpected call: ${url}`);
    },
  });
  page.$nextTick = async () => {};
  page.loadHistory = () => {};

  const load = page.init();
  assert.deepEqual(urls, ['/ui/jobs/job-1']);
  completeDetails({ ok: true, json: async () => ({ Title: 'Role' }) });
  await load;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(urls, ['/ui/jobs/job-1', '/ui/jobs/job-1/company-application-summary']);
  assert.equal(page.companyApplications.loaded, true);
  assert.equal(page.companyApplications.last365Days, 4);
  assert.ok(events.has('job-history-refresh'));

  events.get('job-history-refresh')({ detail: { jobId: 'other-job' } });
  assert.equal(urls.length, 2);
  events.get('job-history-refresh')({ detail: { jobId: 'job-1' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(urls.length, 3);
});

test('company summary error can be retried without showing a false zero', async () => {
  let calls = 0;
  const { page } = makePage({
    fetchResponse: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 503 };
      return { ok: true, json: async () => ({
        available: true, companyName: 'Agency', last90Days: 0, last365Days: 1,
      }) };
    },
  });

  await page.loadCompanyApplications();
  assert.equal(page.companyApplications.loaded, false);
  assert.ok(page.companyApplications.error);
  await page.loadCompanyApplications();
  assert.equal(page.companyApplications.error, '');
  assert.equal(page.companyApplications.last90Days, 0);
  assert.equal(page.companyApplications.last365Days, 1);
});

test('unknown company is not shown as zero applications', async () => {
  const { page } = makePage({
    fetchResponse: async () => ({ ok: true, json: async () => ({
      available: false, companyName: null, last90Days: null, last365Days: null,
    }) }),
  });
  await page.loadCompanyApplications();
  assert.equal(page.companyApplications.loaded, true);
  assert.equal(page.companyApplications.available, false);
  assert.equal(page.companyApplications.last90Days, null);
});

test('late company summary response does not overwrite the newest result', async () => {
  let completeFirst;
  let calls = 0;
  const { page } = makePage({
    fetchResponse: () => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => { completeFirst = resolve; });
      return Promise.resolve({ ok: true, json: async () => ({
        available: true, companyName: 'Agency', last90Days: 2, last365Days: 4,
      }) });
    },
  });

  const firstLoad = page.loadCompanyApplications();
  await page.loadCompanyApplications();
  completeFirst({ ok: true, json: async () => ({
    available: true, companyName: 'Agency', last90Days: 1, last365Days: 3,
  }) });
  await firstLoad;
  assert.equal(page.companyApplications.last90Days, 2);
  assert.equal(page.companyApplications.last365Days, 4);
});

test('invalid company application counts do not appear on the page', async () => {
  const { page } = makePage({
    fetchResponse: async () => ({ ok: true, json: async () => ({
      available: true, companyName: 'Agency', last90Days: 7, last365Days: 2,
    }) }),
  });
  await page.loadCompanyApplications();
  assert.equal(page.companyApplications.loaded, false);
  assert.ok(page.companyApplications.error);
});
