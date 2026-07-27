import test from 'node:test';
import assert from 'node:assert/strict';

import { htmlToPlainText } from '../src/details/text.mjs';
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
    locations: [],
    remoteType: 'Unknown',
    canonicalIdentity: {
      provider: 'greenhouse',
      providerTenant: 'example',
      externalId: '123',
      identitySource: 'url',
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
    /boards-api\.greenhouse\.io\/v1\/boards\/example\/jobs\/123/,
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
  assert.equal(result.detail.status, 'ok');
});

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
