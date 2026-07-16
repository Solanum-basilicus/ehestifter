import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCreatePayload,
} from '../src/ehestifter/job-payload.mjs';

import {
  createJobsClient,
} from '../src/ehestifter/jobs-client.mjs';

import {
  importCandidates,
} from '../src/ehestifter/import-jobs.mjs';

function candidate(overrides = {}) {
  return {
    url:
      'https://job-boards.greenhouse.io/example/jobs/123',

    applyUrl:
      'https://job-boards.greenhouse.io/example/jobs/123',

    foundOn: 'career-ops-scan',
    sourceCompany: 'Example GmbH',
    hiringCompanyName: 'Example GmbH',
    postingCompanyName: null,
    title: 'Product Manager',
    remoteType: 'Hybrid',
    description: 'A full description.',
    locations: [
      {
        countryName: 'Germany',
        countryCode: 'de',
        cityName: 'Berlin',
        region: 'Berlin',
      },
    ],
    canonicalIdentity: {
      provider: 'greenhouse',
      providerTenant: 'example',
      externalId: '123',
      identitySource: 'url',
    },
    existingJobId: null,
    preflight: {
      status: 'ok',
      exists: false,
    },
    ...overrides,
  };
}

test('buildCreatePayload uses scanner provenance and Jobs identity', () => {
  const payload = buildCreatePayload(candidate());

  assert.equal(
    payload.foundOn,
    'career-ops-scan',
  );

  assert.equal(
    payload.provider,
    'greenhouse',
  );

  assert.equal(
    payload.providerTenant,
    'example',
  );

  assert.equal(
    payload.externalId,
    '123',
  );

  assert.equal(
    payload.hiringCompanyName,
    'Example GmbH',
  );

  assert.deepEqual(payload.locations, [
    {
      countryName: 'Germany',
      countryCode: 'DE',
      cityName: 'Berlin',
      region: 'Berlin',
    },
  ]);
});

test('createJob reconciles an ambiguous POST through exists', async () => {
  const calls = [];

  const fetchImpl = async (url, options) => {
    calls.push({
      url: String(url),
      options,
    });

    if (options.method === 'POST') {
      throw new DOMException(
        'Request timed out',
        'AbortError',
      );
    }

    return new Response(
      JSON.stringify({
        exists: true,
        id: '11111111-1111-1111-1111-111111111111',
        provider: 'greenhouse',
        providerTenant: 'example',
        externalId: '123',
        identitySource: 'url',
        foundOn: 'corporate-site',
        hiringCompanyName: 'example',
        postingCompanyName: null,
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      },
    );
  };

  const client = createJobsClient(
    {
      baseUrl: 'https://jobs.example/api',
      functionKey: 'secret',
      timeoutMs: 1000,
      retryCount: 0,
    },
    {
      fetchImpl,
    },
  );

  const payload = buildCreatePayload(candidate());

  const result = await client.createJob(
    payload,
    {
      reconcileUrl: payload.url,
    },
  );

  assert.equal(
    result.disposition,
    'reconciled_after_ambiguous_post',
  );

  assert.equal(
    result.id,
    '11111111-1111-1111-1111-111111111111',
  );

  const post = calls.find(
    (call) => call.options.method === 'POST',
  );

  assert.equal(
    post.options.headers['x-actor-type'],
    'system',
  );

  assert.equal(
    JSON.parse(post.options.body).foundOn,
    'career-ops-scan',
  );
});

test('importCandidates enforces the create cap', async () => {
  let createCalls = 0;

  const client = {
    async createJob() {
      createCalls += 1;

      return {
        id: `00000000-0000-0000-0000-00000000000${createCalls}`,
        disposition: 'submitted',
        reconciled: false,
        responseStatus: 201,
      };
    },
  };

  const results = await importCandidates(
    [
      candidate(),
      candidate({
        url:
          'https://job-boards.greenhouse.io/example/jobs/456',

        canonicalIdentity: {
          provider: 'greenhouse',
          providerTenant: 'example',
          externalId: '456',
          identitySource: 'url',
        },
      }),
    ],
    client,
    {
      maxCreates: 1,
      requireDescription: true,
    },
  );

  assert.equal(createCalls, 1);
  assert.equal(
    results[0].import.status,
    'submitted',
  );
  assert.equal(
    results[1].import.status,
    'skipped_create_limit',
  );
});
