import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWorkdayDetailEndpoint,
  enrichCandidateDetails,
  parseWorkdayDetailPayload,
} from '../src/details/fetchers.mjs';
import workday, {
  parseWorkdayResponse,
} from '../src/providers/workday.mjs';

function candidate(overrides = {}) {
  return {
    url: 'https://adobe.wd5.myworkdayjobs.com/external_experienced/job/San-Jose/Software-Engineer_R123',
    applyUrl: 'https://adobe.wd5.myworkdayjobs.com/external_experienced/job/San-Jose/Software-Engineer_R123',
    foundOn: 'ats-discovery',
    sourceProvider: 'workday',
    sourceTenant: 'adobe.wd5.myworkdayjobs.com/external_experienced',
    description: '',
    descriptionStatus: 'missing',
    rawLocation: 'San Jose',
    locations: [{
      countryName: 'United States',
      countryCode: 'US',
      cityName: 'San Jose',
      region: 'California',
    }],
    remoteType: 'Unknown',
    canonicalIdentity: {
      provider: 'workday',
      providerTenant: 'adobe',
      externalId: 'Software-Engineer_R123',
      identitySource: 'url',
    },
    preflight: {
      status: 'ok',
      exists: false,
    },
    provenance: {
      sourceOrigin: 'https://adobe.wd5.myworkdayjobs.com',
      providerNativeId: '/job/San-Jose/Software-Engineer_R123',
      targetSequence: 1,
    },
    ...overrides,
  };
}

function detailPayload(overrides = {}) {
  return {
    jobPostingInfo: {
      jobDescription: '<h2>The role</h2><p>Build reliable systems &amp; products.</p>',
      externalUrl: '/en-US/external_experienced/job/San-Jose/Software-Engineer_R123',
      location: {
        name: 'Remote - United States',
        country: 'United States',
        city: 'San Jose',
        region: 'California',
      },
      additionalLocations: [
        {
          name: 'Austin, Texas',
          country: 'United States',
          city: 'Austin',
          region: 'Texas',
        },
      ],
      workplaceType: 'Remote',
      canApply: true,
      ...overrides,
    },
  };
}

test('Workday listing preserves externalPath and exposes structured source identity', () => {
  const entry = {
    name: 'Adobe',
    careers_url: 'https://adobe.wd5.myworkdayjobs.com/en-US/external_experienced',
  };
  const jobs = parseWorkdayResponse({
    jobPostings: [{
      title: 'Software Engineer',
      externalPath: '/job/San-Jose/Software-Engineer_R123',
      locationsText: 'San Jose',
    }],
  }, entry);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, '/job/San-Jose/Software-Engineer_R123');
  assert.equal(
    jobs[0].url,
    'https://adobe.wd5.myworkdayjobs.com/external_experienced/job/San-Jose/Software-Engineer_R123',
  );
  assert.equal(
    workday.tenant(entry),
    'adobe.wd5.myworkdayjobs.com/external_experienced',
  );
  assert.equal(
    workday.sourceOrigin(entry),
    'https://adobe.wd5.myworkdayjobs.com',
  );
});

test('Workday structured catalog identity preserves a nested career-site path', () => {
  const entry = {
    name: 'Nested site',
    careers_url: 'https://example.wd3.myworkdayjobs.com/division/external',
    workday_site: 'division/external',
  };
  const jobs = parseWorkdayResponse({
    jobPostings: [{
      title: 'Engineer',
      externalPath: '/job/Berlin/Engineer_R1',
    }],
  }, entry);

  assert.equal(workday.tenant(entry), 'example.wd3.myworkdayjobs.com/division/external');
  assert.equal(
    jobs[0].url,
    'https://example.wd3.myworkdayjobs.com/division/external/job/Berlin/Engineer_R1',
  );
});

test('Workday detail endpoint is derived only from matching structured identity', () => {
  assert.equal(
    buildWorkdayDetailEndpoint(candidate()).href,
    'https://adobe.wd5.myworkdayjobs.com/wday/cxs/adobe/external_experienced/job/San-Jose/Software-Engineer_R123',
  );

  assert.throws(
    () => buildWorkdayDetailEndpoint(candidate({
      sourceTenant: 'other.wd5.myworkdayjobs.com/external_experienced',
    })),
    /host must match source origin/,
  );
  assert.throws(
    () => buildWorkdayDetailEndpoint(candidate({
      provenance: {
        sourceOrigin: 'https://adobe.wd5.myworkdayjobs.com',
        providerNativeId: '/job/../admin',
      },
    })),
    /path traversal/,
  );
  assert.throws(
    () => buildWorkdayDetailEndpoint(candidate({
      url: 'https://evil.example/external_experienced/job/San-Jose/Software-Engineer_R123',
    })),
    /must match source origin/,
  );
});

test('Workday detail parser requires the live CXS response shape', () => {
  const endpoint = buildWorkdayDetailEndpoint(candidate());
  assert.throws(
    () => parseWorkdayDetailPayload({}, endpoint),
    /no jobPostingInfo object/,
  );
  assert.throws(
    () => parseWorkdayDetailPayload({ jobPostingInfo: {} }, endpoint),
    /jobDescription must be a string/,
  );
});

test('Workday details normalize description and improve same-origin metadata', async () => {
  const calls = [];
  const [result] = await enrichCandidateDetails([candidate()], {
    concurrency: 2,
    maxFetches: 10,
    timeoutMs: 1000,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify(detailPayload()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://adobe.wd5.myworkdayjobs.com/wday/cxs/adobe/external_experienced/job/San-Jose/Software-Engineer_R123',
  );
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'error');
  assert.match(calls[0].options.headers['user-agent'], /Mozilla/);
  assert.equal(calls[0].options.headers['accept-language'], 'en-US,en;q=0.9');
  assert.equal(result.description, 'The role\nBuild reliable systems & products.');
  assert.equal(result.descriptionStatus, 'workday-cxs-detail-api');
  assert.equal(
    result.applyUrl,
    'https://adobe.wd5.myworkdayjobs.com/en-US/external_experienced/job/San-Jose/Software-Engineer_R123',
  );
  assert.equal(result.detailRawLocation, 'Remote - United States; Austin, Texas');
  assert.equal(result.remoteType, 'Remote');
  assert.deepEqual(result.locations, [
    {
      countryName: 'United States',
      countryCode: null,
      cityName: 'San Jose',
      region: 'California',
    },
    {
      countryName: 'United States',
      countryCode: null,
      cityName: 'Austin',
      region: 'Texas',
    },
  ]);
  assert.equal(result.detail.status, 'ok');
});

test('Workday detail retains listing metadata when the response cannot improve it', async () => {
  const input = candidate({ remoteType: 'Hybrid' });
  const [result] = await enrichCandidateDetails([input], {
    concurrency: 1,
    maxFetches: 10,
    timeoutMs: 1000,
    fetchImpl: async () => new Response(JSON.stringify(detailPayload({
      externalUrl: 'https://adobe.wd5.myworkdayjobs.com/external_experienced/job/Other/Other_R999',
      location: '',
      additionalLocations: [],
      workplaceType: '',
    })), { status: 200 }),
  });

  assert.equal(result.applyUrl, input.applyUrl);
  assert.equal(result.detailRawLocation, null);
  assert.deepEqual(result.locations, input.locations);
  assert.equal(result.remoteType, 'Hybrid');
});

test('Workday 404, 410, and canApply=false are explicit unavailable results', async () => {
  for (const status of [404, 410]) {
    const [result] = await enrichCandidateDetails([candidate()], {
      concurrency: 1,
      maxFetches: 10,
      timeoutMs: 1000,
      fetchImpl: async () => new Response('gone', { status }),
    });
    assert.equal(result.detail.status, 'unavailable');
    assert.equal(result.detail.responseStatus, status);
  }

  const [closed] = await enrichCandidateDetails([candidate()], {
    concurrency: 1,
    maxFetches: 10,
    timeoutMs: 1000,
    fetchImpl: async () => new Response(JSON.stringify(detailPayload({ canApply: false })), {
      status: 200,
    }),
  });
  assert.equal(closed.detail.status, 'unavailable');
  assert.equal(closed.detail.responseStatus, null);
});

test('Workday changed response shape and oversized responses remain detail errors', async () => {
  const [changed] = await enrichCandidateDetails([candidate()], {
    concurrency: 1,
    maxFetches: 10,
    timeoutMs: 1000,
    fetchImpl: async () => new Response(JSON.stringify({ jobPosting: {} }), { status: 200 }),
  });
  assert.equal(changed.detail.status, 'error');
  assert.match(changed.detail.error, /no jobPostingInfo object/);

  const [oversized] = await enrichCandidateDetails([candidate()], {
    concurrency: 1,
    maxFetches: 10,
    timeoutMs: 1000,
    fetchImpl: async () => new Response('{}', {
      status: 200,
      headers: { 'content-length': '5000001' },
    }),
  });
  assert.equal(oversized.detail.status, 'error');
  assert.match(oversized.detail.error, /exceeds 5000000 bytes/);
});

test('Workday requests are serialized per origin while respecting global concurrency', async () => {
  const second = candidate({
    url: 'https://adobe.wd5.myworkdayjobs.com/external_experienced/job/Austin/Platform-Engineer_R456',
    applyUrl: 'https://adobe.wd5.myworkdayjobs.com/external_experienced/job/Austin/Platform-Engineer_R456',
    provenance: {
      sourceOrigin: 'https://adobe.wd5.myworkdayjobs.com',
      providerNativeId: '/job/Austin/Platform-Engineer_R456',
      targetSequence: 1,
    },
  });
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  let firstStartedResolve;
  let releaseFirstResolve;
  const firstStarted = new Promise((resolve) => { firstStartedResolve = resolve; });
  const releaseFirst = new Promise((resolve) => { releaseFirstResolve = resolve; });

  const pending = enrichCandidateDetails([candidate(), second], {
    concurrency: 2,
    maxFetches: 10,
    timeoutMs: 1000,
    fetchImpl: async (url) => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls === 1) {
        firstStartedResolve();
        await releaseFirst;
      }
      active -= 1;
      const externalUrl = String(url).includes('Platform-Engineer')
        ? '/external_experienced/job/Austin/Platform-Engineer_R456'
        : '/external_experienced/job/San-Jose/Software-Engineer_R123';
      return new Response(JSON.stringify(detailPayload({ externalUrl })), { status: 200 });
    },
  });

  await firstStarted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  releaseFirstResolve();
  const results = await pending;
  assert.equal(results.every((item) => item.detail.status === 'ok'), true);
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
});


test('Workday detail fetch respects the configured timeout', async () => {
  const [result] = await enrichCandidateDetails([candidate()], {
    concurrency: 1,
    maxFetches: 10,
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted', 'AbortError'));
      }, { once: true });
    }),
  });

  assert.equal(result.detail.status, 'error');
  assert.match(result.detail.error, /aborted/i);
});

test('Workday origin serialization does not block another tenant origin', async () => {
  const other = candidate({
    url: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/Berlin/AI-Engineer_JR1',
    applyUrl: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/Berlin/AI-Engineer_JR1',
    sourceTenant: 'nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite',
    provenance: {
      sourceOrigin: 'https://nvidia.wd5.myworkdayjobs.com',
      providerNativeId: '/job/Berlin/AI-Engineer_JR1',
      targetSequence: 2,
    },
  });
  let active = 0;
  let maxActive = 0;
  let bothStartedResolve;
  const bothStarted = new Promise((resolve) => { bothStartedResolve = resolve; });
  let releaseResolve;
  const release = new Promise((resolve) => { releaseResolve = resolve; });

  const pending = enrichCandidateDetails([candidate(), other], {
    concurrency: 2,
    maxFetches: 10,
    timeoutMs: 1000,
    fetchImpl: async (url) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 2) bothStartedResolve();
      await release;
      active -= 1;
      const externalUrl = String(url).includes('nvidia')
        ? '/NVIDIAExternalCareerSite/job/Berlin/AI-Engineer_JR1'
        : '/external_experienced/job/San-Jose/Software-Engineer_R123';
      return new Response(JSON.stringify(detailPayload({ externalUrl })), { status: 200 });
    },
  });

  await bothStarted;
  assert.equal(maxActive, 2);
  releaseResolve();
  const results = await pending;
  assert.equal(results.every((item) => item.detail.status === 'ok'), true);
});
