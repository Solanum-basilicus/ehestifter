import test from 'node:test';
import assert from 'node:assert/strict';

import {
  candidateFromJob,
  classifyProviderError,
  runTrackedScan,
} from '../src/scan/tracked-source.mjs';

function job({
  id = '1',
  title = 'Product Manager',
  company = 'Example',
  url = `https://example.test/jobs/${id}`,
  location = 'Berlin, Germany',
  description = 'Product strategy and roadmap ownership',
  postedAt = Date.parse('2026-07-19T00:00:00.000Z'),
} = {}) {
  return { id, title, company, url, location, description, postedAt };
}

function target({
  sequence = 0,
  tenant = 'example',
  targetClass = 'priority',
  reason = 'tracked_company',
  jobs = [job()],
  error = null,
} = {}) {
  const provider = {
    id: 'ashby',
    async fetch() {
      if (error) throw error;
      return jobs;
    },
  };
  return {
    sequence,
    provider: 'ashby',
    tenant,
    name: tenant,
    careers_url: `https://jobs.ashbyhq.com/${tenant}`,
    targetClass,
    reason,
    catalog: targetClass === 'normal'
      ? {
        source: { repository: 'Feashliaa/job-board-aggregator' },
        rawSha256: 'a'.repeat(64),
        fetchedAtUtc: '2026-07-20T00:00:00.000Z',
        acceptedItemCount: 10,
      }
      : null,
    _provider: provider,
  };
}

function portalConfig(overrides = {}) {
  return {
    title_filter: {
      positive: ['Product Manager'],
      negative: ['Junior'],
    },
    location_filter: {
      allow: ['Germany', 'Remote'],
    },
    max_posting_age_days: 30,
    ...overrides,
  };
}

function providerMap(targets) {
  return new Map([
    ['ashby', targets[0]?._provider ?? { id: 'ashby', fetch: async () => [] }],
  ]);
}

async function scan(targets, options = {}) {
  let tick = 0;
  return runTrackedScan({
    portalConfig: options.portalConfig ?? portalConfig(),
    targets,
    providers: providerMap(targets),
    concurrency: options.concurrency ?? 3,
    maxCandidates: options.maxCandidates ?? 100,
    upstreamRef: 'upstream-ref',
    nowMs: Date.parse('2026-07-20T00:00:00.000Z'),
    monotonicNow: () => {
      tick += 5;
      return tick;
    },
    httpContextFactory: () => ({ transport: 'test' }),
  });
}

test('candidateFromJob maps priority target provenance without changing foundOn', () => {
  const candidate = candidateFromJob(job(), target(), 'ref');
  assert.equal(candidate.sourceMode, 'priority');
  assert.equal(candidate.foundOn, 'career-ops-scan');
  assert.equal(candidate.provenance.targetReason, 'tracked_company');
  assert.equal(candidate.provenance.catalog, null);
});

test('catalog candidate carries catalog source mode and provenance', async () => {
  const result = await scan([
    target({ targetClass: 'normal', reason: 'ashby_catalog' }),
  ]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].sourceMode, 'catalog');
  assert.equal(result.candidates[0].provenance.targetReason, 'ashby_catalog');
  assert.equal(
    result.candidates[0].provenance.catalog.rawSha256,
    'a'.repeat(64),
  );
});

test('provider success records raw jobs, retained candidates, and duration', async () => {
  const result = await scan([
    target({ jobs: [job({ id: '1' }), job({ id: '2' })] }),
  ]);
  assert.deepEqual(result.providerResults[0], {
    sequence: 0,
    provider: 'ashby',
    tenant: 'example',
    targetClass: 'priority',
    status: 'ok',
    errorClass: null,
    errorMessage: null,
    jobsReturned: 2,
    candidatesRetained: 2,
    durationMs: 5,
  });
});

test('one provider failure does not stop another target', async () => {
  const networkError = new Error('host unavailable');
  networkError.code = 'ENOTFOUND';
  const failed = target({ sequence: 0, tenant: 'failed', error: networkError });
  const successful = target({
    sequence: 1,
    tenant: 'successful',
    jobs: [job({ id: '2', company: 'Successful' })],
  });

  const result = await scan([failed, successful]);
  assert.equal(result.providerResults[0].status, 'error');
  assert.equal(result.providerResults[0].errorClass, 'network');
  assert.equal(result.providerResults[1].status, 'ok');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].sourceCompany, 'successful');
});

test('non-array provider result is a provider error instead of silent empty success', async () => {
  const bad = target();
  bad._provider.fetch = async () => ({ jobs: [] });
  const result = await scan([bad]);

  assert.equal(result.providerResults[0].status, 'error');
  assert.equal(result.providerResults[0].errorClass, 'provider_error');
  assert.match(result.providerResults[0].errorMessage, /non-array/);
});

test('cheap filters remain active for planned targets', async () => {
  const result = await scan([
    target({
      jobs: [
        job({ id: '1', title: 'Junior Product Manager' }),
        job({ id: '2', title: 'Product Manager', location: 'United States' }),
        job({ id: '3', title: 'Product Manager', location: 'Remote Germany' }),
      ],
    }),
  ]);

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].url.endsWith('/3'), true);
  assert.deepEqual(
    result.rejected.map((item) => item.reason),
    ['title_filter', 'location_filter'],
  );
  assert.equal(result.providerResults[0].candidatesRetained, 1);
});

test('candidate cap remains global across planned targets', async () => {
  const result = await scan([
    target({ sequence: 0, tenant: 'one', jobs: [job({ id: '1' }), job({ id: '2' })] }),
    target({ sequence: 1, tenant: 'two', jobs: [job({ id: '3' }), job({ id: '4' })] }),
  ], { maxCandidates: 3 });

  assert.equal(result.candidates.length, 3);
  assert.equal(
    result.providerResults.reduce((sum, item) => sum + item.candidatesRetained, 0),
    3,
  );
});

test('duplicate URLs are retained once across targets', async () => {
  const shared = job({ id: 'shared' });
  const result = await scan([
    target({ sequence: 0, tenant: 'one', jobs: [shared] }),
    target({ sequence: 1, tenant: 'two', jobs: [shared] }),
  ]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.rejected[0].reason, 'duplicate_url_in_run');
});

for (const [name, error, expected] of [
  ['abort', Object.assign(new Error('aborted'), { name: 'AbortError' }), 'timeout'],
  ['timeout code', Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), 'timeout'],
  ['rate limit', Object.assign(new Error('HTTP 429'), { status: 429 }), 'rate_limited'],
  ['other 4xx', Object.assign(new Error('HTTP 404'), { status: 404 }), 'http_4xx'],
  ['5xx', Object.assign(new Error('HTTP 503'), { status: 503 }), 'http_5xx'],
  ['network code', Object.assign(new Error('reset'), { code: 'ECONNRESET' }), 'network'],
  ['fetch type error', new TypeError('fetch failed'), 'network'],
  ['schema type error', new TypeError('cannot read property jobs'), 'provider_error'],
  ['unknown', new Error('schema changed'), 'provider_error'],
]) {
  test(`classifyProviderError maps ${name}`, () => {
    assert.equal(classifyProviderError(error), expected);
  });
}

test('provider error classification follows nested causes', () => {
  const cause = Object.assign(new Error('upstream'), { status: 429 });
  const error = new Error('fetch wrapper', { cause });
  assert.equal(classifyProviderError(error), 'rate_limited');
});

test('provider diagnostic message is bounded', async () => {
  const result = await scan([
    target({ error: new Error('x'.repeat(1000)) }),
  ]);
  assert.equal(result.providerResults[0].errorMessage.length, 500);
  assert.equal(result.providerResults[0].errorMessage.endsWith('...'), true);
});
