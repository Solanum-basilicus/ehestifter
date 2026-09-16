import test from 'node:test';
import assert from 'node:assert/strict';

import { enrichCandidateDetails } from '../src/details/fetchers.mjs';

function response(body, {
  status = 200,
  headers = {},
  setCookies = [],
  url = null,
} = {}) {
  const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    url,
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        if (key === 'content-length') return headers[key] ?? String(bytes.length);
        if (key === 'set-cookie') return setCookies.join(', ') || (headers[key] ?? null);
        return headers[key] ?? null;
      },
      getSetCookie() { return [...setCookies]; },
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    async text() { return bytes.toString('utf8'); },
  };
}

function candidate(overrides = {}) {
  return {
    sourceProvider: 'smartrecruiters',
    sourceTenant: 'Acme',
    sourceCompany: 'Acme',
    url: 'https://jobs.smartrecruiters.com/Acme/42-role',
    applyUrl: null,
    description: '',
    descriptionStatus: 'missing',
    locations: [],
    remoteType: 'Unknown',
    provenance: {
      providerNativeId: '42',
      sourceOrigin: 'https://jobs.smartrecruiters.com',
    },
    canonicalIdentity: {
      provider: 'corporate-site',
      providerTenant: 'jobs.smartrecruiters.com',
      externalId: 'ignored-by-source-detail',
    },
    preflight: { status: 'ok', exists: false },
    ...overrides,
  };
}

test('detail dispatch uses acquisition source instead of Jobs canonical provider', async () => {
  let requested = null;
  const [result] = await enrichCandidateDetails([candidate()], {
    concurrency: 1,
    maxFetches: 1,
    timeoutMs: 1000,
    async fetchImpl(url) {
      requested = String(url);
      return response({
        applyUrl: 'https://jobs.smartrecruiters.com/Acme/42/apply',
        location: { country: 'Germany', city: 'Berlin', remote: true },
        jobAd: {
          sections: {
            jobDescription: { title: 'Role', text: '<p>Build products.</p>' },
            qualifications: { title: 'Qualifications', text: '<ul><li>Lead</li></ul>' },
          },
        },
      });
    },
  });
  assert.equal(
    requested,
    'https://api.smartrecruiters.com/v1/companies/Acme/postings/42',
  );
  assert.equal(result.detail.status, 'ok');
  assert.equal(result.detail.provider, 'smartrecruiters');
  assert.match(result.description, /Build products/);
  assert.deepEqual(result.locations[0], {
    countryName: 'Germany',
    countryCode: null,
    cityName: 'Berlin',
    region: null,
  });
  assert.equal(result.remoteType, 'Remote');
});

test('Softgarden detail uses same-host JobPosting JSON-LD', async () => {
  const source = candidate({
    sourceProvider: 'softgarden',
    sourceTenant: 'acme',
    url: 'https://acme.softgarden.io/job/42/product-manager',
    provenance: {
      providerNativeId: '42',
      sourceOrigin: 'https://acme.softgarden.io',
    },
  });
  const [result] = await enrichCandidateDetails([source], {
    concurrency: 1,
    maxFetches: 1,
    timeoutMs: 1000,
    async fetchImpl() {
      return response(`<script type="application/ld+json">${JSON.stringify({
        '@type': 'JobPosting',
        description: '<p>Softgarden role</p>',
        jobLocation: { address: { addressCountry: 'Germany', addressLocality: 'Munich' } },
      })}</script>`);
    },
  });
  assert.equal(result.detail.status, 'ok');
  assert.equal(result.descriptionStatus, 'softgarden-jobposting-jsonld');
  assert.equal(result.locations[0].cityName, 'Munich');
});

test('SuccessFactors detail rejects a URL outside configured source origin', async () => {
  const source = candidate({
    sourceProvider: 'successfactors',
    sourceTenant: 'jobs.example.com',
    url: 'https://other.example.com/job/42',
    provenance: {
      providerNativeId: '42',
      sourceOrigin: 'https://jobs.example.com',
    },
  });
  let calls = 0;
  const [result] = await enrichCandidateDetails([source], {
    concurrency: 1,
    maxFetches: 1,
    timeoutMs: 1000,
    async fetchImpl() { calls += 1; return response(''); },
  });
  assert.equal(calls, 0);
  assert.equal(result.detail.status, 'error');
  assert.match(result.detail.error, /must match the configured source origin/);
});

test('Personio list description skips detail fetching', async () => {
  let calls = 0;
  const [result] = await enrichCandidateDetails([candidate({
    sourceProvider: 'personio',
    description: 'Already supplied in XML',
    descriptionStatus: 'provider-list',
  })], {
    concurrency: 1,
    maxFetches: 1,
    timeoutMs: 1000,
    async fetchImpl() { calls += 1; return response(''); },
  });
  assert.equal(calls, 0);
  assert.equal(result.detail.status, 'already_present');
  assert.equal(result.detail.provider, 'personio');
});

test('unsupported detail status identifies the acquisition provider', async () => {
  const [result] = await enrichCandidateDetails([candidate({
    sourceProvider: 'unknown-ats',
  })], {
    concurrency: 1,
    maxFetches: 1,
    timeoutMs: 1000,
    async fetchImpl() { throw new Error('must not fetch'); },
  });
  assert.equal(result.detail.status, 'unsupported_provider');
  assert.equal(result.detail.provider, 'unknown-ats');
});

test('detail response size ceiling rejects oversized content before parsing', async () => {
  const [result] = await enrichCandidateDetails([candidate()], {
    concurrency: 1,
    maxFetches: 1,
    timeoutMs: 1000,
    async fetchImpl() {
      return response('{}', { headers: { 'content-length': '6000000' } });
    },
  });
  assert.equal(result.detail.status, 'error');
  assert.match(result.detail.error, /exceeds 5000000 bytes/);
});

test('unsafe detail apply URL is ignored in favor of original candidate URL', async () => {
  const [result] = await enrichCandidateDetails([candidate()], {
    concurrency: 1,
    maxFetches: 1,
    timeoutMs: 1000,
    async fetchImpl() {
      return response({
        applyUrl: 'javascript:alert(1)',
        jobAd: { sections: { jobDescription: { text: 'Role' } } },
      });
    },
  });
  assert.equal(result.applyUrl, candidate().url);
});

test('oversized error response is bounded before diagnostic formatting', async () => {
  const [result] = await enrichCandidateDetails([candidate()], {
    concurrency: 1,
    maxFetches: 1,
    timeoutMs: 1000,
    async fetchImpl() {
      return response('error', {
        status: 500,
        headers: { 'content-length': '6000000' },
      });
    },
  });
  assert.equal(result.detail.status, 'error');
  assert.match(result.detail.error, /Detail error response exceeds 5000000 bytes/);
});

test('SuccessFactors RMK detail falls back to server-rendered job description HTML', async () => {
  const source = candidate({
    sourceProvider: 'successfactors',
    sourceTenant: 'careers.ey.com/ey',
    url: 'https://careers.ey.com/ey/job/GenAI-Manager/813646501/',
    provenance: {
      providerNativeId: '813646501',
      sourceOrigin: 'https://careers.ey.com',
    },
  });
  const html = `
    <html><body>
      <a href="/ey/job/GenAI-Manager/813646501/apply">Apply now</a>
      <h1>GenAI Manager</h1>
      <div class="jobdescription">
        <p>At EY, lead large-scale data initiatives.</p>
        <div><strong>Your responsibilities</strong></div>
        <ul><li>Lead delivery teams.</li></ul>
      </div>
      <footer>Footer navigation</footer>
    </body></html>`;
  const [result] = await enrichCandidateDetails([source], {
    concurrency: 1,
    maxFetches: 1,
    timeoutMs: 1000,
    async fetchImpl() { return response(html); },
  });
  assert.equal(result.detail.status, 'ok');
  assert.equal(result.descriptionStatus, 'successfactors-html-detail');
  assert.match(result.description, /lead large-scale data initiatives/i);
  assert.match(result.description, /Lead delivery teams/);
  assert.equal(
    result.applyUrl,
    'https://careers.ey.com/ey/job/GenAI-Manager/813646501/apply',
  );
});

test('SuccessFactors HTML detail keeps LOCATION evidence for GEO normalization', async () => {
  const source = candidate({
    sourceProvider: 'successfactors',
    sourceTenant: 'jobs.nordex-online.com',
    url: 'https://jobs.nordex-online.com/job/Hamburg-Role-22419/1382371633/',
    provenance: {
      providerNativeId: '1382371633',
      sourceOrigin: 'https://jobs.nordex-online.com',
    },
  });
  const html = `
    <h1>SCADA Requirements Engineer</h1>
    <div>REQUISITION ID: 12006</div>
    <div>LOCATION:&nbsp;</div>
    <div>Hamburg, DE, 22419</div>
    <div>DEPARTMENT: Engineering</div>
    <div class="jobdescription"><p>Define SCADA requirements.</p></div>`;
  const [result] = await enrichCandidateDetails([source], {
    concurrency: 1,
    maxFetches: 1,
    timeoutMs: 1000,
    async fetchImpl() { return response(html); },
  });

  assert.equal(result.detail.status, 'ok');
  assert.equal(result.detailRawLocation, 'Hamburg, DE, 22419');
  assert.equal(result.remoteType, 'Unknown');
});

test('SuccessFactors HTML detail supports a Job description heading fallback', async () => {
  const source = candidate({
    sourceProvider: 'successfactors',
    sourceTenant: 'jobs.example.com',
    url: 'https://jobs.example.com/job/Role/42/',
    provenance: {
      providerNativeId: '42',
      sourceOrigin: 'https://jobs.example.com',
    },
  });
  const html = `
    <h2>Job description</h2>
    <p>Build and operate the platform.</p>
    <h2>Similar Jobs</h2>
    <p>This must not become part of the description.</p>`;
  const [result] = await enrichCandidateDetails([source], {
    concurrency: 1,
    maxFetches: 1,
    timeoutMs: 1000,
    async fetchImpl() { return response(html); },
  });
  assert.equal(result.detail.status, 'ok');
  assert.match(result.description, /Build and operate/);
  assert.doesNotMatch(result.description, /must not become part/);
});

test('SuccessFactors HTML detail recognizes a German description heading', async () => {
  const source = candidate({
    sourceProvider: 'successfactors',
    sourceTenant: 'jobs.example.com',
    url: 'https://jobs.example.com/job/Role/43/',
    provenance: {
      providerNativeId: '43',
      sourceOrigin: 'https://jobs.example.com',
    },
  });
  const [result] = await enrichCandidateDetails([source], {
    concurrency: 1,
    maxFetches: 1,
    timeoutMs: 1000,
    async fetchImpl() {
      return response('<h2>Stellenbeschreibung</h2><p>Verantworte die Plattform.</p><footer>Ende</footer>');
    },
  });
  assert.equal(result.detail.status, 'ok');
  assert.match(result.description, /Verantworte die Plattform/);
});


test('SuccessFactors detail bootstraps and reuses a same-origin session cookie', async () => {
  const source = candidate({
    sourceProvider: 'successfactors',
    sourceTenant: 'wlgore.jobs.hr.cloud.sap',
    url: 'https://wlgore.jobs.hr.cloud.sap/job/Role/1954-de_DE',
    provenance: {
      providerNativeId: '1954',
      sourceOrigin: 'https://wlgore.jobs.hr.cloud.sap',
    },
  });
  const requests = [];
  const [result] = await enrichCandidateDetails([source], {
    concurrency: 1,
    maxFetches: 1,
    timeoutMs: 1000,
    async fetchImpl(url, options = {}) {
      const headers = new Headers(options.headers ?? {});
      requests.push({ url: String(url), headers });
      if (String(url) === 'https://wlgore.jobs.hr.cloud.sap/') {
        return response('<html>bootstrap</html>', {
          url: String(url),
          setCookies: ['JSESSIONID=session-1; Path=/; Secure; HttpOnly'],
        });
      }
      assert.equal(headers.get('cookie'), 'JSESSIONID=session-1');
      return response(
        '<div class="job-description"><p>Operate manufacturing equipment.</p></div>',
        { url: String(url) },
      );
    },
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://wlgore.jobs.hr.cloud.sap/');
  assert.equal(requests[1].url, source.url);
  assert.equal(result.detail.status, 'ok');
  assert.equal(result.descriptionStatus, 'successfactors-html-detail');
  assert.match(result.description, /Operate manufacturing equipment/);
});

test('concurrent SuccessFactors details share one bootstrap per source origin', async () => {
  const first = candidate({
    sourceProvider: 'successfactors',
    sourceTenant: 'wlgore.jobs.hr.cloud.sap',
    url: 'https://wlgore.jobs.hr.cloud.sap/job/Role-One/1954-de_DE',
    provenance: {
      providerNativeId: '1954',
      sourceOrigin: 'https://wlgore.jobs.hr.cloud.sap',
    },
  });
  const second = candidate({
    sourceProvider: 'successfactors',
    sourceTenant: 'wlgore.jobs.hr.cloud.sap',
    url: 'https://wlgore.jobs.hr.cloud.sap/job/Role-Two/1911-de_DE',
    provenance: {
      providerNativeId: '1911',
      sourceOrigin: 'https://wlgore.jobs.hr.cloud.sap',
    },
  });
  let bootstrapCalls = 0;
  let detailCalls = 0;

  const results = await enrichCandidateDetails([first, second], {
    concurrency: 2,
    maxFetches: 2,
    timeoutMs: 1000,
    async fetchImpl(url, options = {}) {
      const value = String(url);
      if (value === 'https://wlgore.jobs.hr.cloud.sap/') {
        bootstrapCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return response('<html>bootstrap</html>', {
          url: value,
          setCookies: ['JSESSIONID=shared; Path=/; Secure; HttpOnly'],
        });
      }
      detailCalls += 1;
      assert.equal(new Headers(options.headers ?? {}).get('cookie'), 'JSESSIONID=shared');
      return response(
        '<div class="job-description"><p>Shared session detail.</p></div>',
        { url: value },
      );
    },
  });

  assert.equal(bootstrapCalls, 1);
  assert.equal(detailCalls, 2);
  assert.deepEqual(results.map((item) => item.detail.status), ['ok', 'ok']);
});

test('SuccessFactors detail refreshes its session once after 401', async () => {
  const source = candidate({
    sourceProvider: 'successfactors',
    sourceTenant: 'jobs.example.com',
    url: 'https://jobs.example.com/job/Role/42-en_US',
    provenance: {
      providerNativeId: '42',
      sourceOrigin: 'https://jobs.example.com',
    },
  });
  let bootstraps = 0;
  let details = 0;

  const [result] = await enrichCandidateDetails([source], {
    concurrency: 1,
    maxFetches: 1,
    timeoutMs: 1000,
    async fetchImpl(url, options = {}) {
      const value = String(url);
      if (value === 'https://jobs.example.com/') {
        bootstraps += 1;
        return response('<html>bootstrap</html>', {
          url: value,
          setCookies: [`JSESSIONID=session-${bootstraps}; Path=/; Secure; HttpOnly`],
        });
      }
      details += 1;
      const cookie = new Headers(options.headers ?? {}).get('cookie');
      if (details === 1) {
        assert.equal(cookie, 'JSESSIONID=session-1');
        return response('expired', { status: 401, url: value });
      }
      assert.equal(cookie, 'JSESSIONID=session-2');
      return response(
        '<div class="job-description"><p>Refreshed detail.</p></div>',
        { url: value },
      );
    },
  });

  assert.equal(bootstraps, 2);
  assert.equal(details, 2);
  assert.equal(result.detail.status, 'ok');
  assert.match(result.description, /Refreshed detail/);
});


test('SuccessFactors detail still runs when best-effort bootstrap fails', async () => {
  const source = candidate({
    sourceProvider: 'successfactors',
    sourceTenant: 'careers.example.com',
    url: 'https://careers.example.com/job/Role/42/',
    provenance: {
      providerNativeId: '42',
      sourceOrigin: 'https://careers.example.com',
    },
  });
  let calls = 0;
  const [result] = await enrichCandidateDetails([source], {
    concurrency: 1,
    maxFetches: 1,
    timeoutMs: 1000,
    async fetchImpl(url) {
      calls += 1;
      if (String(url) === 'https://careers.example.com/') {
        return response('bootstrap unavailable', { status: 503, url: String(url) });
      }
      return response(
        '<div class="job-description"><p>Public detail remains readable.</p></div>',
        { url: String(url) },
      );
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.detail.status, 'ok');
  assert.match(result.description, /Public detail remains readable/);
});

test('SuccessFactors unavailable shell is reported separately from parser failure', async () => {
  const source = candidate({
    sourceProvider: 'successfactors',
    sourceTenant: 'jobs.example.com',
    url: 'https://jobs.example.com/job/Role/42-en_US',
    provenance: {
      providerNativeId: '42',
      sourceOrigin: 'https://jobs.example.com',
    },
  });
  const [result] = await enrichCandidateDetails([source], {
    concurrency: 1,
    maxFetches: 1,
    timeoutMs: 1000,
    async fetchImpl(url) {
      if (String(url) === 'https://jobs.example.com/') {
        return response('<html>bootstrap</html>', { url: String(url) });
      }
      return response(
        `<main>You can't view this job because it's not available at this time.</main>`,
        { url: String(url) },
      );
    },
  });
  assert.equal(result.detail.status, 'unavailable');
  assert.match(result.detail.error, /job is unavailable/);
});

test('BambooHR detail uses the public job detail endpoint', async () => {
  const source = candidate({
    sourceProvider: 'bamboohr',
    sourceTenant: 'acme',
    url: 'https://acme.bamboohr.com/careers/35',
    provenance: {
      providerNativeId: '35',
      sourceOrigin: 'https://acme.bamboohr.com',
    },
  });
  const calls = [];
  const [result] = await enrichCandidateDetails([source], {
    concurrency: 1,
    maxFetches: 1,
    timeoutMs: 1000,
    async fetchImpl(url) {
      calls.push(String(url));
      return response({
        result: {
          jobOpening: {
            description: '<p>Build useful products.</p>',
            jobOpeningShareUrl: 'https://acme.bamboohr.com/careers/35',
          },
        },
      });
    },
  });

  assert.deepEqual(calls, ['https://acme.bamboohr.com/careers/35/detail']);
  assert.equal(result.detail.status, 'ok');
  assert.equal(result.descriptionStatus, 'bamboohr-detail-json');
  assert.match(result.description, /Build useful products/);
});

test('BambooHR detail keeps ATS location and location type evidence', async () => {
  const source = candidate({
    sourceProvider: 'bamboohr',
    sourceTenant: 'anovasolutions',
    url: 'https://anovasolutions.bamboohr.com/careers/473',
    provenance: {
      providerNativeId: '473',
      sourceOrigin: 'https://anovasolutions.bamboohr.com',
    },
  });
  const [result] = await enrichCandidateDetails([source], {
    concurrency: 1,
    maxFetches: 1,
    timeoutMs: 1000,
    async fetchImpl() {
      return response({
        result: {
          jobOpening: {
            description: '<p>Lead product work.</p>',
            location: {
              city: null,
              state: null,
              postalCode: null,
              addressCountry: null,
            },
            atsLocation: {
              country: 'United States',
              countryId: '1',
              state: 'Nebraska',
              city: 'Blair',
            },
            isRemote: null,
            locationType: '1',
            jobOpeningShareUrl: 'https://anovasolutions.bamboohr.com/careers/473',
          },
        },
      });
    },
  });

  assert.equal(result.detailRawLocation, 'Blair, Nebraska, United States, Remote');
  assert.equal(result.remoteType, 'Remote');
  assert.deepEqual(result.locations, [{
    countryName: 'United States',
    countryCode: null,
    cityName: 'Blair',
    region: 'Nebraska',
  }]);
});

test('BambooHR detail ignores a cross-origin share URL', async () => {
  const source = candidate({
    sourceProvider: 'bamboohr',
    sourceTenant: 'acme',
    url: 'https://acme.bamboohr.com/careers/35',
    provenance: {
      providerNativeId: '35',
      sourceOrigin: 'https://acme.bamboohr.com',
    },
  });
  const [result] = await enrichCandidateDetails([source], {
    concurrency: 1,
    maxFetches: 1,
    timeoutMs: 1000,
    async fetchImpl() {
      return response({
        result: {
          jobOpening: {
            description: '<p>Build useful products.</p>',
            jobOpeningShareUrl: 'https://example.com/untrusted',
          },
        },
      });
    },
  });

  assert.equal(result.applyUrl, source.url);
});

test('BambooHR detail rejects a mismatched job URL before fetch', async () => {
  const source = candidate({
    sourceProvider: 'bamboohr',
    sourceTenant: 'acme',
    url: 'https://acme.bamboohr.com/careers/99',
    provenance: {
      providerNativeId: '35',
      sourceOrigin: 'https://acme.bamboohr.com',
    },
  });
  let calls = 0;
  const [result] = await enrichCandidateDetails([source], {
    concurrency: 1,
    maxFetches: 1,
    timeoutMs: 1000,
    async fetchImpl() { calls += 1; return response('{}'); },
  });
  assert.equal(calls, 0);
  assert.equal(result.detail.status, 'error');
  assert.match(result.detail.error, /must match the source tenant and job id/);
});

test('iCIMS detail uses same-origin JobPosting JSON-LD and browser headers', async () => {
  const source = candidate({
    sourceProvider: 'icims',
    sourceTenant: 'careers-rambus.icims.com',
    url: 'https://careers-rambus.icims.com/jobs/23020/senior-engineer/job',
    provenance: {
      providerNativeId: '23020',
      sourceOrigin: 'https://careers-rambus.icims.com',
    },
  });
  let request = null;
  const [result] = await enrichCandidateDetails([source], {
    concurrency: 1,
    maxFetches: 1,
    timeoutMs: 1000,
    async fetchImpl(url, options = {}) {
      request = { url: String(url), headers: new Headers(options.headers ?? {}) };
      return response(`<script type="application/ld+json">${JSON.stringify({
        '@type': 'JobPosting',
        description: '<p>Design memory interfaces.</p>',
        url: '/jobs/23020/senior-engineer/job',
        jobLocation: { address: { addressCountry: 'Germany', addressLocality: 'Berlin' } },
      })}</script>`);
    },
  });

  assert.equal(request.url, source.url);
  assert.match(request.headers.get('user-agent'), /Mozilla/);
  assert.equal(result.detail.status, 'ok');
  assert.equal(result.descriptionStatus, 'icims-jobposting-jsonld');
  assert.equal(result.locations[0].cityName, 'Berlin');
});

test('iCIMS detail rejects a cross-origin URL before fetch', async () => {
  const source = candidate({
    sourceProvider: 'icims',
    sourceTenant: 'careers-rambus.icims.com',
    url: 'https://careers-other.icims.com/jobs/23020/role/job',
    provenance: {
      providerNativeId: '23020',
      sourceOrigin: 'https://careers-rambus.icims.com',
    },
  });
  let calls = 0;
  const [result] = await enrichCandidateDetails([source], {
    concurrency: 1,
    maxFetches: 1,
    timeoutMs: 1000,
    async fetchImpl() { calls += 1; return response(''); },
  });
  assert.equal(calls, 0);
  assert.equal(result.detail.status, 'error');
  assert.match(result.detail.error, /must match the source origin and provider-native id/);
});

test('Paylocity detail uses the public job page and JobPosting JSON-LD', async () => {
  const source = candidate({
    sourceProvider: 'paylocity',
    sourceTenant: '8e0feae7-e42f-437e-97b1-53b917185eed',
    url: 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/123',
    provenance: {
      providerNativeId: '123',
      sourceOrigin: 'https://recruiting.paylocity.com',
    },
  });
  const [result] = await enrichCandidateDetails([source], {
    concurrency: 1,
    maxFetches: 1,
    timeoutMs: 1000,
    async fetchImpl() {
      return response(`<script type="application/ld+json">${JSON.stringify({
        '@type': 'JobPosting',
        description: '<p>Run the product program.</p>',
        url: '/Recruiting/Jobs/Details/123',
        jobLocationType: 'TELECOMMUTE',
        applicantLocationRequirements: { '@type': 'Country', name: 'Germany' },
      })}</script>`);
    },
  });

  assert.equal(result.detail.status, 'ok');
  assert.equal(result.descriptionStatus, 'paylocity-jobposting-jsonld');
  assert.equal(result.remoteType, 'Remote');
  assert.equal(result.locations[0].countryName, 'Germany');
});

test('Paylocity detail rejects a mismatched provider-native id before fetch', async () => {
  const source = candidate({
    sourceProvider: 'paylocity',
    sourceTenant: '8e0feae7-e42f-437e-97b1-53b917185eed',
    url: 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/999',
    provenance: {
      providerNativeId: '123',
      sourceOrigin: 'https://recruiting.paylocity.com',
    },
  });
  let calls = 0;
  const [result] = await enrichCandidateDetails([source], {
    concurrency: 1,
    maxFetches: 1,
    timeoutMs: 1000,
    async fetchImpl() { calls += 1; return response(''); },
  });
  assert.equal(calls, 0);
  assert.equal(result.detail.status, 'error');
  assert.match(result.detail.error, /must match the source board and provider-native id/);
});
