import test from 'node:test';
import assert from 'node:assert/strict';

import paylocity, {
  extractPaylocityPageData,
  parsePaylocityListing,
  resolvePaylocityBoard,
} from '../src/providers/paylocity.mjs';

const BOARD = '8e0feae7-e42f-437e-97b1-53b917185eed';
const LISTING = `https://recruiting.paylocity.com/Recruiting/Jobs/All/${BOARD}`;

function payload() {
  return {
    ModuleTitle: 'Acme',
    Jobs: [
      {
        JobId: 123,
        JobTitle: 'Product Manager',
        IsInternal: false,
        PublishedDate: '2026-08-01T10:00:00Z',
        JobLocation: { City: 'Berlin', State: 'Berlin', Country: 'Germany' },
      },
      {
        JobId: 124,
        JobTitle: 'Internal Role',
        IsInternal: true,
      },
    ],
  };
}

test('Paylocity accepts only the public board URL with a UUID', () => {
  assert.deepEqual(resolvePaylocityBoard({ careers_url: LISTING }), {
    boardId: BOARD,
    listingUrl: LISTING,
  });
  assert.equal(paylocity.tenant({ careers_url: LISTING }), BOARD);
  assert.equal(resolvePaylocityBoard({ careers_url: `${LISTING}?x=1` }), null);
  assert.equal(resolvePaylocityBoard({ careers_url: 'https://recruiting.paylocity.com/Recruiting/Jobs/All/not-a-uuid' }), null);
  assert.equal(resolvePaylocityBoard({ careers_url: 'https://example.com/Recruiting/Jobs/All/8e0feae7-e42f-437e-97b1-53b917185eed' }), null);
});

test('Paylocity pageData parser does not execute JavaScript', () => {
  const data = extractPaylocityPageData(
    `<script>window.pageData = ${JSON.stringify(payload())}; window.bad = true;</script>`,
  );
  assert.equal(data.Jobs[0].JobId, 123);
  assert.throws(
    () => extractPaylocityPageData('<script>window.pageData = evil();</script>'),
    /must start with an object/,
  );
});

test('Paylocity parser maps external jobs and provider-native ids', () => {
  const jobs = parsePaylocityListing(payload(), { name: 'Acme' }, BOARD);
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0], {
    id: '123',
    title: 'Product Manager',
    url: 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/123',
    company: 'Acme',
    location: 'Berlin, Germany',
    postedAt: Date.parse('2026-08-01T10:00:00Z'),
  });
});

test('Paylocity parser rejects duplicate public job ids', () => {
  const duplicate = payload();
  duplicate.Jobs.push({ ...duplicate.Jobs[0] });
  assert.throws(
    () => parsePaylocityListing(duplicate, { name: 'Acme' }, BOARD),
    /duplicate JobId 123/,
  );
});

test('Paylocity fetch reads one public listing page with browser headers', async () => {
  const calls = [];
  const jobs = await paylocity.fetch(
    { name: 'Acme', careers_url: LISTING },
    {
      async fetchText(url, options) {
        calls.push({ url: String(url), options });
        return `<script>window.pageData = ${JSON.stringify(payload())};</script>`;
      },
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, LISTING);
  assert.equal(calls[0].options.redirect, 'error');
  assert.match(calls[0].options.headers['user-agent'], /Mozilla/);
  assert.equal(jobs.length, 1);
});
