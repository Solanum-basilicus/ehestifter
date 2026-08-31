import test from 'node:test';
import assert from 'node:assert/strict';

import icims, {
  parseIcimsSearchPage,
  parseJibeApplyIdentity,
  parseJibeJobsPage,
  resolveIcimsNextPageUrl,
  resolveIcimsOrigin,
  resolveIcimsSearchUrl,
  resolveJibeEndpoint,
} from '../src/providers/icims.mjs';
import {
  classifyProviderError,
  isTransientProviderResult,
  providerHttpStatus,
} from '../src/scan/provider-errors.mjs';
import { icimsVariant, targetHealthIdentity } from '../src/providers/_variant.mjs';

function card(id, title, location = 'Berlin, Germany', href = null) {
  return `<div class="iCIMS_JobCardItem">
    <h3>${title}</h3>
    <span class="field-label">Location</span><span>${location}</span>
    <a href="${href ?? `/jobs/${id}/role-${id}/job`}">View</a>
  </div>`;
}

function intro(searchHref = '/jobs/search?hashed=-435708792&amp;ss=1') {
  return `<main><a href="${searchHref}">view all open job positions</a></main>`;
}

function nextPage(page) {
  return `<nav><a href="/jobs/search?o=&amp;pr=${page}&amp;schemaId=">Page ${page + 1}</a></nav>`;
}

test('iCIMS requires a tenant portal host and keeps the full host as tenant', () => {
  const entry = { careers_url: 'https://careers-rambus.icims.com/jobs/search' };
  assert.equal(resolveIcimsOrigin(entry), 'https://careers-rambus.icims.com');
  assert.equal(icims.tenant(entry), 'careers-rambus.icims.com');
  assert.equal(resolveIcimsOrigin({ careers_url: 'https://www.icims.com/jobs' }), null);
  assert.equal(resolveIcimsOrigin({ careers_url: 'http://careers-rambus.icims.com/jobs' }), null);
});

test('iCIMS bootstrap keeps the tenant-generated hashed search URL', () => {
  const origin = 'https://careers-rambus.icims.com';
  assert.equal(
    resolveIcimsSearchUrl(intro(), origin),
    `${origin}/jobs/search?hashed=-435708792&ss=1`,
  );
});

test('iCIMS bootstrap and pagination reject foreign search URLs', () => {
  const origin = 'https://careers-rambus.icims.com';
  assert.equal(
    resolveIcimsSearchUrl(intro('https://other.icims.com/jobs/search?ss=1'), origin),
    null,
  );
  assert.equal(
    resolveIcimsNextPageUrl(
      '<a href="https://other.icims.com/jobs/search?pr=1">Page 2</a>',
      origin,
      0,
    ),
    null,
  );
});

test('iCIMS pagination follows the next page emitted by the portal', () => {
  const origin = 'https://careers-rambus.icims.com';
  assert.equal(
    resolveIcimsNextPageUrl(nextPage(1), origin, 0),
    `${origin}/jobs/search?o=&pr=1&schemaId=`,
  );
  assert.equal(resolveIcimsNextPageUrl(nextPage(2), origin, 0), null);
});

test('iCIMS parser accepts same-origin numeric jobs and ignores foreign links', () => {
  const origin = 'https://careers-rambus.icims.com';
  const jobs = parseIcimsSearchPage(
    card('23020', 'Senior &amp; Staff Engineer')
      + card('23021', 'Foreign', 'Remote', 'https://other.icims.com/jobs/23021/role/job')
      + card('23020', 'Duplicate'),
    origin,
    'Rambus',
  );

  assert.deepEqual(jobs, [{
    id: '23020',
    title: 'Senior & Staff Engineer',
    url: `${origin}/jobs/23020/role-23020/job`,
    company: 'Rambus',
    location: 'Berlin, Germany',
    acquisitionMode: 'classic-html',
  }]);
});

test('iCIMS fetch bootstraps the first page and honors the smaller page cap', async () => {
  const calls = [];
  const jobs = await icims.fetch(
    {
      name: 'Rambus',
      careers_url: 'https://careers-rambus.icims.com',
      max_pages: 10,
    },
    {
      maxPages: 1,
      async fetchText(url, options) {
        calls.push({ url: String(url), options });
        if (calls.length === 1) return intro();
        return card('23020', 'Engineer') + nextPage(1);
      },
    },
  );

  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].url,
    'https://careers-rambus.icims.com/jobs/intro?mobile=true&needsRedirect=false',
  );
  assert.equal(
    calls[1].url,
    'https://careers-rambus.icims.com/jobs/search?hashed=-435708792&ss=1',
  );
  assert.match(calls[0].options.headers['user-agent'], /Mozilla/);
  assert.match(calls[1].options.headers['user-agent'], /Mozilla/);
  assert.equal(
    calls[1].options.headers.referer,
    'https://careers-rambus.icims.com/jobs/intro?mobile=true&needsRedirect=false',
  );
  assert.equal(jobs.length, 1);
});

test('iCIMS fetch follows portal pagination and deduplicates provider ids', async () => {
  const calls = [];
  const jobs = await icims.fetch(
    { name: 'Rambus', careers_url: 'https://careers-rambus.icims.com', max_pages: 3 },
    {
      async sleep() {},
      async fetchText(url) {
        calls.push(String(url));
        if (calls.length === 1) return intro();
        if (calls.length === 2) {
          return card('23020', 'Engineer') + nextPage(1);
        }
        return card('23020', 'Engineer') + card('23021', 'Staff Engineer');
      },
    },
  );

  assert.deepEqual(calls, [
    'https://careers-rambus.icims.com/jobs/intro?mobile=true&needsRedirect=false',
    'https://careers-rambus.icims.com/jobs/search?hashed=-435708792&ss=1',
    'https://careers-rambus.icims.com/jobs/search?o=&pr=1&schemaId=',
  ]);
  assert.deepEqual(jobs.map((job) => job.id), ['23020', '23021']);
});

test('iCIMS fetch fails closed when bootstrap has no same-origin search link', async () => {
  await assert.rejects(
    icims.fetch(
      { name: 'Rambus', careers_url: 'https://careers-rambus.icims.com' },
      { async fetchText() { return '<html>No job search link</html>'; } },
    ),
    /portal intro has no same-origin job search link/,
  );
});


test('iCIMS Jibe endpoint requires same-origin HTTPS /api/jobs', () => {
  const entry = {
    careers_url: 'https://careers.teknowledge.com/jobs',
    api: 'https://careers.teknowledge.com/api/jobs',
    provider: 'icims',
    icims_variant: 'jibe',
  };
  assert.deepEqual(resolveJibeEndpoint(entry), {
    origin: 'https://careers.teknowledge.com',
    apiUrl: 'https://careers.teknowledge.com/api/jobs',
  });
  assert.equal(
    resolveJibeEndpoint({ ...entry, api: 'https://other.example/api/jobs' }),
    null,
  );
  assert.equal(
    resolveJibeEndpoint({ ...entry, api: 'https://careers.teknowledge.com/api/other' }),
    null,
  );
});

test('iCIMS Jibe apply identity requires an iCIMS host and matching numeric id', () => {
  assert.deepEqual(
    parseJibeApplyIdentity('https://careers-everty.icims.com/jobs/17621/login', '17621'),
    {
      provider: 'icims',
      providerTenant: 'careers-everty.icims.com',
      externalId: '17621',
      applyUrl: 'https://careers-everty.icims.com/jobs/17621/login',
    },
  );
  assert.equal(
    parseJibeApplyIdentity('https://careers-everty.icims.com/jobs/17622/login', '17621'),
    null,
  );
  assert.equal(
    parseJibeApplyIdentity('https://example.com/jobs/17621/login', '17621'),
    null,
  );
});

test('iCIMS Jibe parser keeps full text and per-job classic iCIMS identity', () => {
  const endpoint = {
    origin: 'https://careers.teknowledge.com',
    apiUrl: 'https://careers.teknowledge.com/api/jobs',
  };
  const jobs = parseJibeJobsPage({
    totalCount: 1,
    jobs: [{
      data: {
        req_id: '17621',
        client_code: 'everty',
        title: 'Senior Accountant',
        description: '<p>Overview text.</p>',
        responsibilities: '<ul><li>Close the books.</li></ul>',
        qualifications: '<p>Accounting degree.</p>',
        full_location: 'Lagos, Nigeria',
        hiring_organization: 'Everty',
        posted_date: '2026-08-21T07:14:00+0000',
        apply_url: 'https://careers-everty.icims.com/jobs/17621/login',
        ats_code: 'icims',
        internal: false,
        external: true,
        searchable: true,
      },
    }],
  }, { name: 'TeKnowledge' }, endpoint);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].url, 'https://careers.teknowledge.com/everty/jobs/17621');
  assert.equal(jobs[0].applyUrl, 'https://careers-everty.icims.com/jobs/17621/login');
  assert.match(jobs[0].description, /Description\nOverview text\./);
  assert.match(jobs[0].description, /Responsibilities\n- Close the books\./);
  assert.match(jobs[0].description, /Qualifications\nAccounting degree\./);
  assert.deepEqual(jobs[0].explicitIdentity, {
    provider: 'icims',
    providerTenant: 'careers-everty.icims.com',
    externalId: '17621',
  });
});

test('iCIMS Jibe parser keeps public API rows when downstream publishing flags are false', () => {
  const endpoint = {
    origin: 'https://careers.teknowledge.com',
    apiUrl: 'https://careers.teknowledge.com/api/jobs',
  };

  const jobs = parseJibeJobsPage({
    jobs: [{ data: {
      req_id: '17621',
      title: 'Senior Accountant',
      description: '<p>Overview text.</p>',
      apply_url: 'https://careers-everty.icims.com/jobs/17621/login',
      ats_code: 'icims',
      internal: false,
      external: false,
      searchable: false,
    } }],
  }, { name: 'TeKnowledge' }, endpoint);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, '17621');
});

test('iCIMS Jibe parser fails closed when apply_url cannot prove iCIMS identity', () => {
  assert.throws(
    () => parseJibeJobsPage({
      jobs: [{ data: {
        req_id: '42',
        title: 'Engineer',
        apply_url: 'https://example.test/jobs/42',
      } }],
    }, { name: 'Example' }, {
      origin: 'https://jobs.example.test',
      apiUrl: 'https://jobs.example.test/api/jobs',
    }),
    /no matching iCIMS apply identity/,
  );
});

test('iCIMS Jibe fetch uses bounded API pagination and reports acquisition telemetry', async () => {
  const calls = [];
  const telemetry = [];
  const makePayload = (id, totalCount) => ({
    totalCount,
    jobs: [{ data: {
      req_id: String(id),
      title: `Role ${id}`,
      description: '<p>Full description</p>',
      full_location: 'Berlin, Germany',
      hiring_organization: 'Example',
      posted_date: '2026-08-27T06:09:00+0000',
      apply_url: `https://careers-example.icims.com/jobs/${id}/login`,
      ats_code: 'icims',
    } }],
  });

  const jobs = await icims.fetch({
    name: 'Example',
    careers_url: 'https://jobs.example.test',
    api: 'https://jobs.example.test/api/jobs',
    icims_variant: 'jibe',
    max_pages: 5,
  }, {
    maxPages: 2,
    async sleep() {},
    reportProviderTelemetry(value) { telemetry.push(value); },
    async fetchJson(url, options) {
      calls.push({ url: String(url), options });
      return calls.length === 1 ? makePayload(1, 150) : makePayload(2, 150);
    },
  });

  assert.equal(jobs.length, 2);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /page=1/);
  assert.match(calls[0].url, /limit=100/);
  assert.match(calls[1].url, /page=2/);
  assert.equal(calls[0].options.headers.accept, 'application/json');
  assert.deepEqual(telemetry.at(-1), {
    acquisitionMode: 'jibe-api',
    explicitTotal: 150,
  });
});

test('iCIMS Jibe pagination uses the actual server page size with totalCount', async () => {
  const calls = [];
  const jobs = await icims.fetch({
    name: 'Example',
    careers_url: 'https://jobs.example.test',
    api: 'https://jobs.example.test/api/jobs',
    icims_variant: 'jibe',
    max_pages: 5,
  }, {
    async sleep() {},
    async fetchJson(url) {
      calls.push(String(url));
      const page = calls.length;
      return {
        totalCount: 3,
        jobs: [{ data: {
          req_id: String(page),
          title: `Role ${page}`,
          description: '<p>Full description</p>',
          apply_url: `https://careers-example.icims.com/jobs/${page}/login`,
          ats_code: 'icims',
        } }],
      };
    },
  });

  assert.equal(jobs.length, 3);
  assert.equal(calls.length, 3);
  assert.match(calls[2], /page=3/);
});

test('iCIMS classic WAF verification response becomes waf_captcha', async () => {
  const cause = Object.assign(new Error('HTTP 405 Not Allowed'), {
    status: 405,
    body: '<html><title>Human Verification</title><script>window.awsWafCookieDomainList=[];window.gokuProps={};</script></html>',
  });
  let thrown;
  try {
    await icims.fetch(
      { name: 'Rambus', careers_url: 'https://careers-rambus.icims.com' },
      { async fetchText() { throw cause; } },
    );
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown);
  assert.equal(thrown.code, 'ICIMS_WAF_CAPTCHA');
  assert.equal(classifyProviderError(thrown), 'waf_captcha');
  assert.equal(providerHttpStatus(thrown), 405);
  assert.equal(isTransientProviderResult({
    status: 'error',
    errorClass: 'waf_captcha',
    httpStatus: 405,
  }), true);
  assert.match(thrown.message, /AWS WAF human verification/);
});


test('iCIMS Jibe variant gets a separate health partition without changing classic keys', () => {
  assert.equal(icimsVariant({ careers_url: 'https://careers-rambus.icims.com' }), null);
  assert.equal(icimsVariant({ careers_url: 'https://example.jibeapply.com/jobs' }), 'jibe');
  assert.deepEqual(targetHealthIdentity({
    provider: 'icims',
    careers_url: 'https://careers.teknowledge.com',
    icims_variant: 'jibe',
  }), {
    provider: 'icims',
    providerVariant: 'jibe',
    healthPartition: 'icims:jibe',
  });
  assert.deepEqual(targetHealthIdentity({
    provider: 'icims',
    careers_url: 'https://careers-rambus.icims.com',
  }), {
    provider: 'icims',
    providerVariant: null,
    healthPartition: 'icims',
  });
});
