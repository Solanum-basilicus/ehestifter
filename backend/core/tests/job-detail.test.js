const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const template = fs.readFileSync(path.join(__dirname, '..', 'templates', 'job.html'), 'utf8');

function makePage() {
  const factories = new Map();
  const context = {
    window: { __relativeFromLocal: (value) => `relative:${value}` },
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
  return { page: factories.get('jobDetailPage')('job-1'), window: context.window };
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
