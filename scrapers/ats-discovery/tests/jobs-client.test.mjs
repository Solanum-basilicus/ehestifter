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
    foundOn: 'ats-discovery',
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

  assert.equal(result.foundOn, 'ats-discovery');

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

test('getJob and updateJobDescription use authenticated system requests', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (options.method === 'GET') {
      return new Response(JSON.stringify({ Id: 'job-guid', Description: '<p>Old</p>' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('Job updated', { status: 200 });
  };
  const client = createJobsClient({
    baseUrl: 'https://jobs.example/api',
    functionKey: 'secret',
    timeoutMs: 1000,
    retryCount: 0,
  }, { fetchImpl });

  const job = await client.getJob('job-guid');
  const update = await client.updateJobDescription(
    'job-guid',
    '<p>New</p>',
  );

  assert.equal(job.Description, '<p>Old</p>');
  assert.equal(update.responseStatus, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[1].options.method, 'PUT');
  assert.equal(calls[1].options.headers['x-functions-key'], 'secret');
  assert.equal(calls[1].options.headers['x-actor-type'], 'system');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    description: '<p>New</p>',
  });
});
