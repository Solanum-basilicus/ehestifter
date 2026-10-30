import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

import { htmlToPlainText } from '../src/details/text.mjs';
import { extractGreenhouseLocationQuestions } from '../src/details/greenhouse-questions.mjs';
import {
  enrichCandidateDetails,
} from '../src/details/fetchers.mjs';

test('htmlToPlainText preserves readable structure', () => {
  const result = htmlToPlainText(`
    <h2>Requirements</h2>
    <ul>
      <li>Build products</li>
      <li>Use R&amp;D evidence</li>
    </ul>
    <p>Berlin&nbsp;or remote</p>
  `);

  assert.match(result, /Requirements/);
  assert.match(result, /- Build products/);
  assert.match(result, /R&D evidence/);
  assert.match(result, /Berlin or remote/);
  assert.doesNotMatch(result, /<[^>]+>/);
});

test('Greenhouse details populate description without changing scanner provenance', async () => {
  const candidate = {
    url: 'https://job-boards.greenhouse.io/example/jobs/123',
    applyUrl: 'https://job-boards.greenhouse.io/example/jobs/123',
    foundOn: 'ats-discovery',
    description: '',
    descriptionStatus: 'missing',
    rawLocation: 'Remote',
    locations: [],
    remoteType: 'Unknown',
    canonicalIdentity: {
      provider: 'greenhouse',
      providerTenant: 'example',
      externalId: 'legacy-url-identity',
      identitySource: 'url',
    },
    provenance: {
      providerNativeId: '456',
    },
    preflight: {
      status: 'ok',
      exists: false,
    },
  };

  const calls = [];

  const [result] = await enrichCandidateDetails(
    [candidate],
    {
      concurrency: 1,
      maxFetches: 10,
      timeoutMs: 1000,
      fetchImpl: async (url) => {
        calls.push(String(url));

        return new Response(
          JSON.stringify({
            absolute_url:
              'https://job-boards.greenhouse.io/example/jobs/123',
            content:
              '<p>Build <strong>useful</strong> systems &amp; products.</p>',
            location: {
              name: 'Remote/Hybrid if local to Maryland',
            },
            questions: [
              { label: 'First Name', required: true, fields: [{ name: 'first_name' }] },
              { label: 'Are you legally authorized to work in the United States without sponsorship?', required: true, fields: [{ name: 'custom', values: ['PRIVATE'] }] },
              { label: 'What is your current city and state of residence?', required: true },
            ],
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      },
    },
  );

  assert.equal(calls.length, 1);
  assert.match(
    calls[0],
    /boards-api\.greenhouse\.io\/v1\/boards\/example\/jobs\/456/,
  );

  assert.equal(
    result.description,
    'Build useful systems & products.',
  );
  assert.equal(
    result.descriptionStatus,
    'greenhouse-detail-api',
  );
  assert.equal(result.foundOn, 'ats-discovery');
  assert.equal(result.rawLocation, 'Remote');
  assert.equal(result.detailRawLocation, 'Remote/Hybrid if local to Maryland');
  assert.equal(result.detail.status, 'ok');
  assert.equal(result.applicationQuestions.length, 2);
  assert.deepEqual(result.applicationQuestions.map((item) => item.kind), [
    'work_authorization', 'residence_or_location',
  ]);
  assert.equal(result.applicationQuestions[0].countryHint, 'US');
  assert.equal(JSON.stringify(result.applicationQuestions).includes('PRIVATE'), false);
});

for (const { httpStatus, nativeId, detailStatus } of [
  { httpStatus: 404, nativeId: '456', detailStatus: 'unavailable' },
  { httpStatus: 410, nativeId: '456', detailStatus: 'unavailable' },
  { httpStatus: 404, nativeId: null, detailStatus: 'error' },
  { httpStatus: 410, nativeId: null, detailStatus: 'error' },
  { httpStatus: 500, nativeId: '456', detailStatus: 'error' },
]) {
  const identityLabel = nativeId ? 'listing-native ID' : 'URL-derived ID';
  test(`Greenhouse HTTP ${httpStatus} with ${identityLabel} gives ${detailStatus}`, async () => {
    const publicUrl = 'https://careers.example.org/vacancy?gh_jid=999&gh_jid=888';
    const candidate = {
      url: publicUrl,
      applyUrl: publicUrl,
      description: '',
      descriptionStatus: 'missing',
      canonicalIdentity: {
        provider: 'greenhouse',
        providerTenant: 'example',
        externalId: 'legacy-id',
        identitySource: 'url',
      },
      provenance: nativeId ? { providerNativeId: nativeId } : {},
      preflight: { status: 'ok', exists: false },
    };
    const calls = [];
    const [result] = await enrichCandidateDetails([candidate], {
      concurrency: 1,
      maxFetches: 1,
      timeoutMs: 1000,
      fetchImpl: async (url) => {
        calls.push(String(url));
        return new Response('Job is not available', { status: httpStatus });
      },
    });

    const expectedUrl = `https://boards-api.greenhouse.io/v1/boards/example/jobs/${nativeId || 'legacy-id'}?questions=true`;
    const expectedAttempts = httpStatus >= 500 ? 2 : 1;
    assert.deepEqual(calls, Array(expectedAttempts).fill(expectedUrl));
    assert.equal(result.detail.status, detailStatus);
    assert.equal(result.detail.provider, 'greenhouse');
    assert.equal(result.detail.responseStatus, httpStatus);
    assert.equal(result.detail.attempts, expectedAttempts);
    assert.equal(result.description, '');
    assert.equal(result.descriptionStatus, 'missing');
    assert.equal(result.url, candidate.url);
    assert.deepEqual(result.canonicalIdentity, candidate.canonicalIdentity);
    assert.deepEqual(result.provenance, candidate.provenance);
  });
}


test('Ashby details reuse one board request and preserve structured primary location', async () => {
  const candidates = ['job-1', 'job-2'].map(
    (externalId) => ({
      url:
        `https://jobs.ashbyhq.com/example/${externalId}`,
      applyUrl:
        `https://jobs.ashbyhq.com/example/${externalId}`,
      foundOn: 'ats-discovery',
      description: '',
      descriptionStatus: 'missing',
      locations: [],
      remoteType: 'Unknown',
      canonicalIdentity: {
        provider: 'ashby',
        providerTenant: 'example',
        externalId,
        identitySource: 'url',
      },
      preflight: {
        status: 'ok',
        exists: false,
      },
    }),
  );

  let calls = 0;

  const results = await enrichCandidateDetails(
    candidates,
    {
      concurrency: 2,
      maxFetches: 10,
      timeoutMs: 1000,
      fetchImpl: async () => {
        calls += 1;

        return new Response(
          JSON.stringify({
            jobs: [
              {
                id: 'job-1',
                descriptionPlain: 'First description',
                applyUrl:
                  'https://jobs.ashbyhq.com/example/job-1/application',
                workplaceType: 'Remote',
                address: {
                  postalAddress: {
                    addressCountry: 'Germany',
                    addressLocality: 'Berlin',
                    addressRegion: 'Berlin-Brandenburg',
                  },
                },
              },
              {
                id: 'job-2',
                descriptionPlain: 'Second description',
                applyUrl:
                  'https://jobs.ashbyhq.com/example/job-2/application',
                workplaceType: 'Hybrid',
                address: {
                  postalAddress: {
                    addressCountry: 'Germany',
                    addressLocality: 'Munich',
                    addressRegion: 'Bavaria',
                  },
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      },
    },
  );

  assert.equal(calls, 1);

  assert.equal(
    results[0].description,
    'First description',
  );
  assert.equal(results[0].remoteType, 'Remote');
  assert.deepEqual(results[0].locations, [
    {
      countryName: 'Germany',
      countryCode: null,
      cityName: 'Berlin',
      region: 'Berlin-Brandenburg',
    },
  ]);

  assert.equal(
    results[1].description,
    'Second description',
  );
  assert.equal(results[1].remoteType, 'Hybrid');
});


function paylocityCandidate() {
  return {
    url: 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/4497769',
    applyUrl: 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/4497769',
    foundOn: 'ats-discovery',
    description: '',
    descriptionStatus: 'missing',
    rawLocation: 'Remote',
    locations: [],
    remoteType: 'Unknown',
    sourceProvider: 'paylocity',
    sourceTenant: '21aecddf-6bcb-40b9-b363-ea03a9703ff3',
    canonicalIdentity: {
      provider: 'paylocity',
      providerTenant: '21aecddf-6bcb-40b9-b363-ea03a9703ff3',
      externalId: '4497769',
      identitySource: 'provider-native-id',
    },
    provenance: {
      sourceOrigin: 'https://recruiting.paylocity.com/',
      providerNativeId: '4497769',
    },
    preflight: {
      status: 'ok',
      exists: false,
    },
  };
}

test('Paylocity details use server-rendered HTML when JobPosting JSON-LD is absent', async () => {
  const fixtureUrl = new URL('./fixtures/paylocity-detail-no-jsonld.html', import.meta.url);
  const html = await readFile(fixtureUrl, 'utf8');
  let calls = 0;

  const [result] = await enrichCandidateDetails([paylocityCandidate()], {
    concurrency: 1,
    maxFetches: 1,
    timeoutMs: 1000,
    fetchImpl: async () => {
      calls += 1;
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.detail.status, 'ok');
  assert.equal(result.descriptionStatus, 'paylocity-html-detail');
  assert.match(result.description, /Lead regional channel development/);
  assert.equal(result.detailRawLocation, 'Fully Remote • Remote - CAN, CAN');
  assert.equal(result.remoteType, 'Remote');
  assert.equal(
    result.applyUrl,
    'https://recruiting.paylocity.com/Recruiting/Jobs/Apply/4497769',
  );
});

test('Paylocity details keep JobPosting JSON-LD as the primary source', async () => {
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    description: '<p>Primary JSON-LD description.</p>',
    url: 'https://recruiting.paylocity.com/Recruiting/Jobs/Apply/4497769',
  });
  const html = `<script type="application/ld+json">${jsonLd}</script>`;

  const [result] = await enrichCandidateDetails([paylocityCandidate()], {
    concurrency: 1,
    maxFetches: 1,
    timeoutMs: 1000,
    fetchImpl: async () => new Response(html, { status: 200 }),
  });

  assert.equal(result.detail.status, 'ok');
  assert.equal(result.descriptionStatus, 'paylocity-jobposting-jsonld');
  assert.equal(result.description, 'Primary JSON-LD description.');
});

test('all eligible details are evaluated without a count limit', async () => {
  const base = {
    preflight: { status: 'ok', exists: false },
    description: '',
    descriptionStatus: 'missing',
    sourceTenant: 'example',
    provenance: { healthPartition: 'unsupported' },
  };
  const results = await enrichCandidateDetails([
    {
      ...base,
      url: 'https://example.test/mismatch',
      sourceProvider: 'unsupported',
      preliminaryGeography: { status: 'mismatch' },
    },
    {
      ...base,
      url: 'https://example.test/matched',
      sourceProvider: 'unsupported',
      preliminaryGeography: { status: 'matched' },
    },
  ], {
    concurrency: 1,
    timeoutMs: 1000,
  });

  assert.equal(results[0].detail.status, 'unsupported_provider');
  assert.equal(results[1].detail.status, 'unsupported_provider');
});

test('Greenhouse question extraction omits identity questions and field values', () => {
  const questions = extractGreenhouseLocationQuestions({ questions: [
    { label: 'Email', fields: [{ value: 'person@example.com' }] },
    { label: '<p>Will you need H-1B visa sponsorship?</p>', required: true,
      fields: [{ values: ['secret'] }] },
    { label: 'Are you authorized to work with us on projects?', required: false },
  ] });
  assert.equal(questions.length, 2);
  assert.equal(questions[0].countryHint, 'US');
  assert.ok(questions.every((item) => !JSON.stringify(item).includes('secret')));
  assert.equal(questions[1].countryHint, null);
});
