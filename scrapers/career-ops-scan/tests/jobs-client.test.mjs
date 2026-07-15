import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createJobsClient,
  preflightCandidates,
} from '../src/ehestifter/jobs-client.mjs';

test('existsByUrl uses Jobs identity response as authority', async () => {
  const calls = [];

  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });

    return new Response(JSON.stringify({
      exists: false,
      id: null,
      provider: 'greenhouse',
      providerTenant: 'example',
      externalId: '123',
      identitySource: 'url',
      foundOn: 'corporate-site',
      hiringCompanyName: 'example',
      postingCompanyName: null,
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });
  };

  const client = createJobsClient({
    baseUrl: 'https://jobs.example/api',
    functionKey: 'secret',
    timeoutMs: 1000,
    retryCount: 0,
  }, { fetchImpl });

  const result = await client.existsByUrl(
    'https://boards.greenhouse.io/example/jobs/123',
  );

  assert.equal(result.exists, false);
  assert.equal(result.id, null);

  assert.deepEqual(result.identity, {
    provider: 'greenhouse',
    providerTenant: 'example',
    externalId: '123',
    identitySource: 'url',
  });

  assert.deepEqual(result.urlInference, {
    foundOn: 'corporate-site',
    hiringCompanyName: 'example',
    postingCompanyName: null,
  });

  assert.match(calls[0].url, /jobs%2F123/);
  assert.equal(
    calls[0].options.headers['x-functions-key'],
    'secret',
  );
});

test('preflightCandidates preserves scanner provenance and maps Jobs identity', async () => {
  const candidate = {
    url: 'https://boards.greenhouse.io/example/jobs/123',
    foundOn: 'career-ops-scan',
    canonicalIdentity: null,
    urlInference: null,
    existingJobId: null,
    preflight: null,
  };

  const client = {
    async existsByUrl() {
      return {
        exists: false,
        id: null,
        identity: {
          provider: 'greenhouse',
          providerTenant: 'example',
          externalId: '123',
          identitySource: 'url',
        },
        urlInference: {
          foundOn: 'corporate-site',
          hiringCompanyName: 'example',
          postingCompanyName: null,
        },
      };
    },
  };

  const [result] = await preflightCandidates(
    [candidate],
    client,
    1,
  );

  assert.equal(result.foundOn, 'career-ops-scan');

  assert.deepEqual(result.canonicalIdentity, {
    provider: 'greenhouse',
    providerTenant: 'example',
    externalId: '123',
    identitySource: 'url',
  });

  assert.deepEqual(result.urlInference, {
    foundOn: 'corporate-site',
    hiringCompanyName: 'example',
    postingCompanyName: null,
  });

  assert.equal(result.existingJobId, null);

  assert.deepEqual(result.preflight, {
    status: 'ok',
    exists: false,
  });
});
