import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { parsePaylocityHtmlDetails } from '../src/details/paylocity-html.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.join(HERE, 'fixtures', 'paylocity-detail-no-jsonld.html'),
  'utf8',
);
const PAGE_URL = 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/4497769';

test('Paylocity HTML fallback extracts the server-rendered job detail', () => {
  const result = parsePaylocityHtmlDetails(FIXTURE, PAGE_URL, '4497769');

  assert.ok(result);
  assert.match(result.description, /^Job Title: Regional Development Manager/);
  assert.match(result.description, /Lead regional channel development/);
  assert.equal(result.rawLocation, 'Fully Remote • Remote - CAN, CAN');
  assert.equal(result.remoteType, 'Remote');
  assert.equal(
    result.applyUrl,
    'https://recruiting.paylocity.com/Recruiting/Jobs/Apply/4497769',
  );
});

test('Paylocity HTML fallback rejects a page with another job apply link', () => {
  assert.equal(
    parsePaylocityHtmlDetails(FIXTURE, PAGE_URL, '4497770'),
    null,
  );
});

test('Paylocity HTML fallback rejects ambiguous description sections', () => {
  const ambiguous = FIXTURE.replace(
    '<div class="job-listing-header">Description</div>',
    '<div class="job-listing-header">Description</div>'
      + '<div>First duplicate description section.</div>'
      + '<div class="job-listing-header">Description</div>',
  );

  assert.equal(
    parsePaylocityHtmlDetails(ambiguous, PAGE_URL, '4497769'),
    null,
  );
});
