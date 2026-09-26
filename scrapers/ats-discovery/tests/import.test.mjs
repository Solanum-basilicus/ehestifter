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

    foundOn: 'ats-discovery',
    sourceProvider: 'greenhouse',
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
    'ats-discovery',
  );

  assert.equal(
    payload.provider,
    'greenhouse',
  );

  assert.equal(
    payload.atsVendor,
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

  assert.equal(Object.hasOwn(payload, 'locations'), false);
  assert.deepEqual(payload.locationsV2, []);
});

test('import creates a valid v2 job even when legacy location evidence is invalid', async () => {
  let postedPayload = null;
  const client = {
    async createJob(payload) {
      postedPayload = payload;
      return {
        id: '00000000-0000-0000-0000-000000000025',
        disposition: 'submitted',
        reconciled: false,
        responseStatus: 201,
      };
    },
  };

  const [result] = await importCandidates(
    [candidate({
      rawLocation: 'DEU AAG Münster - AAS',
      detailRawLocation: 'Münster, Germany',
      locations: [{
        countryName: 'Germany',
        countryCode: 'DE',
        cityName: 'DEU AAG Münster - AAS',
        region: null,
      }],
      locationsV2: [{ kind: 'country', locationId: 'iso3166:DE' }],
      locationNormalization: {
        status: 'normalized_country',
        unresolved: [{ source: 'provider', raw: 'DEU AAG Münster - AAS' }],
      },
    })],
    client,
    {
      maxCreates: 1,
      requireDescription: true,
    },
  );

  assert.equal(result.import.status, 'submitted');
  assert.equal(Object.hasOwn(postedPayload, 'locations'), false);
  assert.equal(Object.hasOwn(result.import.payload, 'locations'), false);
  assert.deepEqual(postedPayload.locationsV2, [
    { kind: 'country', locationId: 'iso3166:DE' },
  ]);
  assert.equal(result.rawLocation, 'DEU AAG Münster - AAS');
  assert.equal(result.detailRawLocation, 'Münster, Germany');
  assert.equal(result.locations[0].cityName, 'DEU AAG Münster - AAS');
  assert.equal(result.locationNormalization.unresolved.length, 1);
});

test('buildCreatePayload keeps ATS vendor separate from Jobs provider', () => {
  const payload = buildCreatePayload(candidate({
    sourceProvider: 'successfactors',
    canonicalIdentity: {
      provider: 'westfalen',
      providerTenant: '',
      externalId: 'Muenster-Senior-Projektmanager',
      identitySource: 'url',
    },
  }));

  assert.equal(payload.atsVendor, 'successfactors');
  assert.equal(payload.provider, 'westfalen');
  assert.equal(payload.providerTenant, '');
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
    'ats-discovery',
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

test('importCandidates safely skips detail-unavailable postings before description gating', async () => {
  let createCalls = 0;
  const client = {
    async createJob() {
      createCalls += 1;
      throw new Error('createJob must not be called');
    },
  };

  const [result] = await importCandidates(
    [candidate({
      description: '',
      detail: {
        status: 'unavailable',
        provider: 'workday',
        responseStatus: 404,
      },
      locationEligibility: {
        status: 'ineligible',
        reason: 'outside_scope',
      },
    })],
    client,
    {
      maxCreates: 1,
      requireDescription: true,
    },
  );

  assert.equal(createCalls, 0);
  assert.equal(result.import.status, 'skipped_detail_unavailable');
  assert.equal(result.import.responseStatus, 404);
});

test('createJob reconciles an ambiguous POST through explicit identity', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (options.method === 'POST') {
      throw new DOMException('Request timed out', 'AbortError');
    }
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('provider'), 'paylocity');
    assert.equal(parsed.searchParams.get('providerTenant'), '8e0feae7-e42f-437e-97b1-53b917185eed');
    assert.equal(parsed.searchParams.get('externalId'), '123');
    assert.equal(parsed.searchParams.has('url'), false);
    return new Response(JSON.stringify({
      exists: true,
      id: '22222222-2222-2222-2222-222222222222',
      provider: 'paylocity',
      providerTenant: '8e0feae7-e42f-437e-97b1-53b917185eed',
      externalId: '123',
      identitySource: 'explicit',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = createJobsClient({
    baseUrl: 'https://jobs.example/api',
    functionKey: 'secret',
    timeoutMs: 1000,
    retryCount: 0,
  }, { fetchImpl });

  const result = await client.createJob(
    { ...buildCreatePayload(candidate()), provider: 'paylocity' },
    {
      reconcileIdentity: {
        provider: 'paylocity',
        providerTenant: '8e0feae7-e42f-437e-97b1-53b917185eed',
        externalId: '123',
      },
    },
  );

  assert.equal(result.disposition, 'reconciled_after_ambiguous_post');
  assert.equal(result.id, '22222222-2222-2222-2222-222222222222');
});

test('importCandidates passes Jobs canonical identity for create reconciliation', async () => {
  let createOptions = null;
  const client = {
    async createJob(_payload, options) {
      createOptions = options;
      return {
        id: '33333333-3333-3333-3333-333333333333',
        disposition: 'submitted',
        reconciled: false,
        responseStatus: 201,
      };
    },
  };

  await importCandidates([candidate()], client, {
    maxCreates: 1,
    requireDescription: true,
  });

  assert.equal(createOptions.reconcileUrl, candidate().url);
  assert.deepEqual(createOptions.reconcileIdentity, candidate().canonicalIdentity);
});
