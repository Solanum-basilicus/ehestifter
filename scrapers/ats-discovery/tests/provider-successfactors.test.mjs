import test from 'node:test';
import assert from 'node:assert/strict';

import successfactors, {
  cityFromSlug,
  cleanSuccessFactorsLocation,
  extractSuccessFactorsCsbBootstrap,
  extractSuccessFactorsLocales,
  parseSuccessFactorsCsbJobs,
  parseSuccessFactorsDate,
  parseSuccessFactorsPublicJobsPage,
  parseSuccessFactorsTiles,
  resolveSuccessFactorsConfig,
  successFactorsTenant,
} from '../src/providers/successfactors.mjs';

const RMK_PAGE = `
<li class="job-tile job-id-100" data-url="/job/Berlin-Senior-Product-Manager-100/100/">
  <a class="jobTitle-link">Senior Product Manager</a>
  <div id="100-section-city-value">Berlin</div>
</li>
<li class="job-tile job-id-101" data-url="/job/Munich-Engineering-Manager-101/101/">
  <a class="jobTitle-link">Engineering Manager</a>
</li>`;

function csbResponse(ids, { totalJobs = ids.length } = {}) {
  return {
    totalJobs,
    jobSearchResult: ids.map((id) => ({
      response: {
        id,
        unifiedStandardTitle: `Product Manager ${id}`,
        unifiedUrlTitle: `Product-Manager-${id}`,
        jobLocationShort: ['Berlin, DEU'],
        unifiedStandardStart: '7/1/26',
      },
    })),
  };
}

test('SuccessFactors config preserves brand path and strips known endpoints', () => {
  const cfg = resolveSuccessFactorsConfig({
    careers_url: 'https://careers.example.com/Bluebeam/search/?q=pm',
    provider: 'successfactors',
  });
  assert.equal(cfg.base, 'https://careers.example.com/Bluebeam');
  assert.equal(cfg.tileApi, 'https://careers.example.com/Bluebeam/tile-search-results/');
  assert.equal(cfg.jobsApi, 'https://careers.example.com/Bluebeam/services/recruiting/v1/jobs');
  assert.equal(cfg.jobBase, 'https://careers.example.com');
  assert.equal(successFactorsTenant({ careers_url: cfg.searchPage }), 'careers.example.com/Bluebeam');
});

test('SuccessFactors rejects non-public or non-HTTPS sources', () => {
  assert.equal(resolveSuccessFactorsConfig({ careers_url: 'http://jobs.sap.com' }), null);
  assert.equal(resolveSuccessFactorsConfig({ careers_url: 'https://localhost/search' }), null);
  assert.equal(resolveSuccessFactorsConfig({ careers_url: 'https://10.0.0.1/search' }), null);
});

test('SuccessFactors auto-detects literal hosts but branded hosts require explicit provider', () => {
  assert.ok(successfactors.detect({ careers_url: 'https://tenant.successfactors.eu/search' }));
  assert.ok(successfactors.detect({ careers_url: 'https://jobs2web.com/acme/search' }));
  assert.equal(successfactors.detect({ careers_url: 'https://jobs.zf.com/search' }), null);
});

test('SuccessFactors RMK tile parser extracts ids, URLs, and city fallback', () => {
  const rows = parseSuccessFactorsTiles(RMK_PAGE, 'https://jobs.example.com');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, '100');
  assert.equal(rows[0].location, 'Berlin');
  assert.equal(rows[0].url, 'https://jobs.example.com/job/Berlin-Senior-Product-Manager-100/100/');
  assert.equal(rows[1].location, 'Munich');
  assert.equal(
    cityFromSlug('/job/Frankfurt-Program-&amp;-Release-Manager-7/7/', 'Program & Release Manager'),
    'Frankfurt',
  );
});

test('SuccessFactors locale discovery is bounded, de-duplicated, and prioritized', () => {
  const html = '?locale=fr_FR &amp;locale=en_GB ?locale=de_DE ?locale=en_US ?locale=fr_FR';
  assert.deepEqual(
    extractSuccessFactorsLocales(html),
    ['de_DE', 'en_US', 'en_GB', 'fr_FR'],
  );
});

test('SuccessFactors CSB bootstrap extracts token, locales, and bounded categories', () => {
  const bootstrap = extractSuccessFactorsCsbBootstrap(`
    <meta content="token-123" name="csrf-token">
    <a href="?locale=en_GB">English</a>
    <a href="/go/Technology/500/">Technology</a>
    <script>{"categoryId": 999}</script>
  `);
  assert.equal(bootstrap.csrfToken, 'token-123');
  assert.deepEqual(bootstrap.locales, ['en_GB']);
  assert.deepEqual(bootstrap.categoryIds, [500]);
});


test('SuccessFactors CSB bootstrap extracts ajaxSetup header token', () => {
  const bootstrap = extractSuccessFactorsCsbBootstrap(`
    <script>
      $.ajaxSetup({
        cache: false,
        headers: {
          "X-CSRF-Token" : "abc+/=_-123"
        }
      });
    </script>
  `);
  assert.equal(bootstrap.csrfToken, 'abc+/=_-123');

  const fetchMarker = extractSuccessFactorsCsbBootstrap(`
    <script>{ headers: { "X-CSRF-Token": "Fetch" } }</script>
  `);
  assert.equal(fetchMarker.csrfToken, null);
});

test('SuccessFactors date and location helpers reject invalid dates and deduplicate', () => {
  assert.equal(parseSuccessFactorsDate('7/1/26'), Date.UTC(2026, 6, 1));
  assert.equal(parseSuccessFactorsDate('1.7.26'), Date.UTC(2026, 6, 1));
  assert.equal(parseSuccessFactorsDate('31.2.26'), undefined);
  assert.equal(
    cleanSuccessFactorsLocation(['Berlin, DEU<br>', 'Berlin, DEU<br>', 'Munich, DEU']),
    'Berlin, DEU / Munich, DEU',
  );
});

test('SuccessFactors CSB parser builds stable detail URLs and timestamps', () => {
  const [job] = parseSuccessFactorsCsbJobs(
    csbResponse(['42']),
    { base: 'https://jobs.example.com/Brand' },
    'de_DE',
  );
  assert.equal(job.id, '42');
  assert.equal(
    job.url,
    'https://jobs.example.com/Brand/job/Product-Manager-42/42-de_DE',
  );
  assert.equal(job.postedAt, Date.UTC(2026, 6, 1));
});

test('SuccessFactors RMK pagination advances by actual tile count and deduplicates', async () => {
  const urls = [];
  const jobs = await successfactors.fetch(
    {
      name: 'Acme',
      provider: 'successfactors',
      careers_url: 'https://jobs.example.com/search',
      max_pages: 3,
    },
    {
      async fetchText(url) {
        urls.push(String(url));
        if (urls.length === 1) return RMK_PAGE;
        if (urls.length === 2) return RMK_PAGE;
        return '';
      },
      async fetchJson() { throw new Error('CSB must not run when RMK returned jobs'); },
    },
  );
  assert.equal(jobs.length, 2);
  assert.match(urls[1], /startrow=2/);
});

test('SuccessFactors empty RMK remains isolated from CSB protocol', async () => {
  const posts = [];
  const textUrls = [];
  const telemetry = [];
  const jobs = await successfactors.fetch(
    {
      name: 'Acme',
      provider: 'successfactors',
      careers_url: 'https://jobs.example.com/search',
      max_pages: 1,
    },
    {
      reportProviderTelemetry(value) { telemetry.push(value); },
      async fetchText(url) {
        textUrls.push(String(url));
        return '<!DOCTYPE html>';
      },
      async fetchJson(url, options) {
        posts.push({ url: String(url), options });
        return csbResponse(['1', '2']);
      },
    },
  );
  assert.equal(textUrls.length, 1);
  assert.equal(posts.length, 0);
  assert.equal(jobs.length, 0);
  assert.equal(telemetry.at(-1).acquisitionMode, 'rmk-html');
  assert.equal(telemetry.at(-1).listingOutcome, 'listing_success_empty_unverified');
});


test('SuccessFactors CSB bootstrap requests a token and uses ajaxSetup value', async () => {
  let bootstrapHeaders;
  let postHeaders;
  const jobs = await successfactors.fetch(
    {
      name: 'Gore',
      provider: 'successfactors',
      careers_url: 'https://jobs.example.com/',
      sf_variant: 'csb',
      sf_locales: ['en_US'],
      max_pages: 1,
    },
    {
      async fetchText(_url, options) {
        bootstrapHeaders = options.headers;
        return `<script>
          $.ajaxSetup({ headers: { "X-CSRF-Token" : "gore-token+/=" } });
        </script>`;
      },
      async fetchJson(_url, options) {
        postHeaders = options.headers;
        return csbResponse(['77']);
      },
    },
  );
  assert.equal(bootstrapHeaders['x-csrf-token'], 'Fetch');
  assert.equal(postHeaders['x-csrf-token'], 'gore-token+/=');
  assert.equal(jobs[0].id, '77');
  assert.equal(jobs[0].acquisitionMode, 'csb-api');
});

test('SuccessFactors explicit CSB locales still perform one session bootstrap', async () => {
  let textCalls = 0;
  const jobs = await successfactors.fetch(
    {
      name: 'Acme',
      provider: 'successfactors',
      careers_url: 'https://jobs.example.com/search',
      sf_variant: 'csb',
      sf_locales: ['en_GB'],
      max_pages: 1,
    },
    {
      async fetchText() {
        textCalls += 1;
        return '<div data-csrf-token="token"></div>';
      },
      async fetchJson() { return csbResponse(['9']); },
    },
  );
  assert.equal(textCalls, 1);
  assert.equal(jobs[0].url.endsWith('/9-en_GB'), true);
});

test('SuccessFactors CSB discovers categories and sends browser request context', async () => {
  const calls = [];
  await successfactors.fetch(
    {
      name: 'Acme',
      provider: 'successfactors',
      careers_url: 'https://jobs.example.com/Brand/search',
      sf_variant: 'csb',
      sf_locales: ['en_GB'],
      max_pages: 1,
    },
    {
      async fetchText() {
        return '<meta name="csrf-token" content="token">'
          + '<a href="/go/Technology/42/">Tech</a>';
      },
      async fetchJson(url, options) {
        calls.push({ url: String(url), options, body: JSON.parse(options.body) });
        return csbResponse(['1']);
      },
    },
  );
  assert.equal(calls[0].body.categoryId, 42);
  assert.equal(calls[0].options.headers.origin, 'https://jobs.example.com');
  assert.equal(calls[0].options.headers.referer, 'https://jobs.example.com/Brand/search/');
  assert.equal(calls[0].options.headers['x-csrf-token'], 'token');
});

test('SuccessFactors refreshes CSB bootstrap once after 401', async () => {
  let bootstraps = 0;
  let posts = 0;
  const jobs = await successfactors.fetch(
    {
      name: 'Acme',
      provider: 'successfactors',
      careers_url: 'https://jobs.example.com/search',
      sf_variant: 'csb',
      sf_locales: ['en_US'],
      max_pages: 1,
    },
    {
      async fetchText() {
        bootstraps += 1;
        return `<meta name="csrf-token" content="token-${bootstraps}">`;
      },
      async fetchJson(_url, options) {
        posts += 1;
        if (posts === 1) {
          const error = new Error('HTTP 401');
          error.status = 401;
          throw error;
        }
        assert.equal(options.headers['x-csrf-token'], 'token-2');
        return csbResponse(['7']);
      },
    },
  );
  assert.equal(bootstraps, 2);
  assert.equal(posts, 2);
  assert.equal(jobs[0].id, '7');
});

test('SuccessFactors reports a safe error after repeated CSB session rejection', async () => {
  let bootstraps = 0;
  let posts = 0;
  await assert.rejects(
    () => successfactors.fetch(
      {
        name: 'Acme',
        provider: 'successfactors',
        careers_url: 'https://jobs.example.com/search',
        sf_variant: 'csb',
        sf_locales: ['en_US', 'de_DE'],
        max_pages: 1,
      },
      {
        async fetchText() {
          bootstraps += 1;
          return '<meta name="csrf-token" content="secret">';
        },
        async fetchJson() {
          posts += 1;
          const error = new Error('body contains sensitive session details');
          error.status = 401;
          throw error;
        },
      },
    ),
    (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.code, 'CSB_SESSION_REJECTED');
      assert.equal(error.message, 'successfactors: csb_session_rejected_and_public_listing_empty');
      assert.doesNotMatch(error.message, /secret|sensitive/);
      return true;
    },
  );
  assert.equal(bootstraps >= 2, true);
  assert.equal(posts, 2);
});

test('SuccessFactors rejects a CSB bootstrap without a token', async () => {
  await assert.rejects(
    () => successfactors.fetch(
      {
        name: 'Acme',
        provider: 'successfactors',
        careers_url: 'https://jobs.example.com/search',
        sf_variant: 'csb',
        max_pages: 1,
      },
      { async fetchText() { return '<html></html>'; } },
    ),
    /csb_bootstrap_token_missing_and_public_listing_empty/,
  );
});

test('SuccessFactors surfaces total CSB transport failure instead of reporting empty success', async () => {
  await assert.rejects(
    () => successfactors.fetch(
      {
        name: 'Acme',
        provider: 'successfactors',
        careers_url: 'https://jobs.example.com/search',
        sf_variant: 'csb',
        sf_locales: ['de_DE', 'en_US'],
        max_pages: 1,
      },
      {
        async fetchText() { return '<meta name="csrf-token" content="token">'; },
        async fetchJson() { throw new Error('upstream unavailable'); },
      },
    ),
    /upstream unavailable/,
  );
});

test('SuccessFactors source origin follows api override rather than branded careers URL', () => {
  assert.equal(
    successfactors.sourceOrigin({
      careers_url: 'https://careers.brand.example/jobs',
      api: 'https://jobs.backend.example/Brand/search',
    }),
    'https://jobs.backend.example',
  );
});

test('SuccessFactors detection inspects hostname rather than query text', () => {
  assert.equal(
    successfactors.detect({ careers_url: 'https://jobs.example.com/?next=successfactors.com' }),
    null,
  );
});

test('SuccessFactors does not report empty CSB success after a partial locale failure', async () => {
  let calls = 0;
  await assert.rejects(
    () => successfactors.fetch(
      {
        name: 'Acme',
        provider: 'successfactors',
        careers_url: 'https://jobs.example.com/search',
        sf_variant: 'csb',
        sf_locales: ['de_DE', 'en_US'],
        max_pages: 1,
      },
      {
        async fetchText() { return '<meta name="csrf-token" content="token">'; },
        async fetchJson() {
          calls += 1;
          if (calls === 1) return { totalJobs: 0, jobSearchResult: [] };
          throw new Error('second locale unavailable');
        },
      },
    ),
    /second locale unavailable/,
  );
});


test('SuccessFactors caps total CSB requests across categories and locales', async () => {
  const categories = Array.from({ length: 16 }, (_, index) => (
    `<a href="/go/Category-${index}/${1000 + index}/">C</a>`
  )).join('');
  let posts = 0;
  const jobs = await successfactors.fetch(
    {
      name: 'Acme',
      provider: 'successfactors',
      careers_url: 'https://jobs.example.com/search',
      sf_variant: 'csb',
      sf_locales: Array.from({ length: 16 }, (_, index) => `aa_${String(index).padStart(2, '0')}`),
      max_pages: 100,
    },
    {
      async fetchText() {
        return `<meta name="csrf-token" content="token">${categories}`;
      },
      async fetchJson() {
        posts += 1;
        return csbResponse(
          Array.from({ length: 10 }, (_, index) => String(index)),
          { totalJobs: 100_000 },
        );
      },
    },
  );
  assert.equal(posts, 200);
  assert.equal(jobs.length, 10);
});

test('SuccessFactors explicit CSB falls back to public RMK tiles when token is absent', async () => {
  const calls = [];
  const jobs = await successfactors.fetch(
    {
      name: 'Gore',
      provider: 'successfactors',
      careers_url: 'https://gore.example.com/',
      sf_variant: 'csb',
      max_pages: 1,
    },
    {
      async fetchText(url) {
        calls.push(String(url));
        if (String(url).includes('tile-search-results')) return RMK_PAGE;
        return '<html><body><a href="/go/All-Jobs/9813400/">All Jobs</a></body></html>';
      },
      async fetchJson() {
        throw new Error('CSB API must not be called without a token');
      },
    },
  );
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].acquisitionMode, 'csb-public-tiles');
  assert.equal(calls.some((url) => url.includes('tile-search-results')), true);
});

test('SuccessFactors CSB public page parser extracts same-origin job links', async () => {
  const cfg = resolveSuccessFactorsConfig({
    careers_url: 'https://gore.example.com/',
  });
  const html = `
    <section class="jobs">
      <div class="jobLocation">Putzbrunn, Germany</div>
      <a href="/job/Product-Manager/12345-en_US">Product Manager</a>
      <a href="https://evil.example/job/Other/999">External</a>
    </section>`;
  const rows = parseSuccessFactorsPublicJobsPage(
    html,
    'https://gore.example.com/go/All-Jobs/9813400/',
    cfg,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, '12345');
  assert.equal(rows[0].title, 'Product Manager');
  assert.equal(rows[0].location, 'Putzbrunn, Germany');
});

test('SuccessFactors explicit public listing URL is same-origin and usable as CSB fallback', async () => {
  const jobs = await successfactors.fetch(
    {
      name: 'Gore',
      provider: 'successfactors',
      careers_url: 'https://gore.example.com/',
      sf_variant: 'csb',
      sf_listing_url: 'https://gore.example.com/go/All-Jobs/9813400/',
      max_pages: 1,
    },
    {
      async fetchText(url) {
        const value = String(url);
        if (value.includes('tile-search-results')) return '';
        if (value.includes('/go/All-Jobs/')) {
          return '<a href="/job/Engineering-Manager/777-en_US">Engineering Manager</a>';
        }
        return '<html>No token</html>';
      },
      async fetchJson() { throw new Error('must not call API'); },
    },
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, '777');
  assert.equal(jobs[0].acquisitionMode, 'csb-public-page');
});

test('SuccessFactors CSB public listing override cannot leave source origin', async () => {
  await assert.rejects(
    () => successfactors.fetch(
      {
        name: 'Gore',
        provider: 'successfactors',
        careers_url: 'https://gore.example.com/',
        sf_variant: 'csb',
        sf_listing_url: 'https://evil.example/go/All-Jobs/1/',
        max_pages: 1,
      },
      {
        async fetchText(url) {
          if (String(url).includes('tile-search-results')) return '';
          return '<html>No token</html>';
        },
        async fetchJson() { throw new Error('must not call API'); },
      },
    ),
    /sf_listing_url must match source origin/,
  );
});

test('SuccessFactors CSB bootstrap transport failure still allows public tiles', async () => {
  let calls = 0;
  const jobs = await successfactors.fetch(
    {
      name: 'Gore',
      provider: 'successfactors',
      careers_url: 'https://gore.example.com/',
      sf_variant: 'csb',
      max_pages: 1,
    },
    {
      async fetchText(url) {
        calls += 1;
        if (calls === 1) throw new Error('homepage unavailable');
        if (String(url).includes('tile-search-results')) return RMK_PAGE;
        return '';
      },
      async fetchJson() { throw new Error('must not call API'); },
    },
  );
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].acquisitionMode, 'csb-public-tiles');
});

test('SuccessFactors public page parser ignores generic apply anchors for a job id', () => {
  const cfg = resolveSuccessFactorsConfig({ careers_url: 'https://jobs.example.com/' });
  const rows = parseSuccessFactorsPublicJobsPage(
    '<a href="/job/Product-Manager/42-en_US">Apply now</a>'
      + '<a href="/job/Product-Manager/42-en_US">Product Manager</a>',
    'https://jobs.example.com/go/All-Jobs/1/',
    cfg,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Product Manager');
});


test('SuccessFactors CSB records explicit zero without treating it as a schema success guess', async () => {
  const telemetry = [];
  const jobs = await successfactors.fetch(
    {
      name: 'Empty CSB',
      provider: 'successfactors',
      careers_url: 'https://empty.jobs.hr.cloud.sap/',
      sf_variant: 'csb',
      sf_locales: ['en_US'],
      max_pages: 1,
    },
    {
      reportProviderTelemetry(value) { telemetry.push(value); },
      async fetchText() {
        return '<script>$.ajaxSetup({headers:{"X-CSRF-Token":"token"}})</script>';
      },
      async fetchJson() {
        return { totalJobs: 0, jobSearchResult: [] };
      },
    },
  );
  assert.deepEqual(jobs, []);
  assert.deepEqual(telemetry.at(-1), {
    acquisitionMode: 'csb-api',
    listingOutcome: 'listing_success_explicit_empty',
    explicitTotal: 0,
  });
});

test('SuccessFactors CSB rejects an empty response without an explicit zero total', async () => {
  const telemetry = [];
  await assert.rejects(
    () => successfactors.fetch(
      {
        name: 'Changed CSB',
        provider: 'successfactors',
        careers_url: 'https://changed.jobs.hr.cloud.sap/',
        sf_variant: 'csb',
        sf_locales: ['en_US'],
        max_pages: 1,
      },
      {
        reportProviderTelemetry(value) { telemetry.push(value); },
        async fetchText() {
          return '<script>$.ajaxSetup({headers:{"X-CSRF-Token":"token"}})</script>';
        },
        async fetchJson() {
          return { result: [] };
        },
      },
    ),
    (error) => error.code === 'CSB_LISTING_SCHEMA_MISMATCH',
  );
  assert.equal(telemetry.at(-1).listingOutcome, 'listing_schema_error');
});
