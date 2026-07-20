import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDiscoveryPolicy } from '../src/policy/discovery-policy.mjs';
import {
  candidateFromJob,
  classifyProviderError,
  runTrackedScan,
} from '../src/scan/tracked-source.mjs';

function policy(overrides = {}) {
  return parseDiscoveryPolicy({
    schema_version: 1,
    defaults: {
      execution: {
        concurrency: 3,
        min_request_interval_ms: 0,
        breaker: {
          rate_limit_threshold: 2,
          transient_error_threshold: 8,
          transient_error_ratio_threshold: 0.5,
          minimum_requests_for_ratio: 10,
          cooldown_minutes: 1440,
        },
      },
      ...overrides,
    },
    providers: { ashby: {} },
  });
}

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
  lookbackStartUtc = '2026-07-17T00:00:00.000Z',
  lookbackUnbounded = false,
} = {}) {
  const provider = {
    id: 'ashby',
    async fetch(_target, context) {
      provider.lastContext = context;
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
    lookbackStartUtc,
    lookbackUnbounded,
    _provider: provider,
  };
}

function portalConfig(overrides = {}) {
  return {
    title_filter: { positive: ['Product Manager'], negative: ['Junior'] },
    location_filter: { allow: ['Germany', 'Remote'] },
    max_posting_age_days: 30,
    ...overrides,
  };
}

async function scan(targets, options = {}) {
  let tick = 0;
  return runTrackedScan({
    portalConfig: options.portalConfig ?? portalConfig(),
    targets,
    providers: new Map([['ashby', targets[0]?._provider ?? { id: 'ashby' }]]),
    policy: options.policy ?? policy(),
    concurrency: options.concurrency ?? 3,
    maxCandidates: options.maxCandidates ?? 100,
    upstreamRef: 'upstream-ref',
    nowMs: Date.parse('2026-07-20T00:00:00.000Z'),
    monotonicNow: () => { tick += 5; return tick; },
    sleep: async () => {},
    httpContextFactory: () => ({ transport: 'test' }),
  });
}

test('priority candidate provenance and foundOn remain stable', () => {
  const candidate = candidateFromJob(job(), target(), 'ref');
  assert.equal(candidate.sourceMode, 'priority');
  assert.equal(candidate.foundOn, 'career-ops-scan');
  assert.equal(candidate.provenance.lookbackStartUtc, '2026-07-17T00:00:00.000Z');
});

test('catalog candidate retains catalog provenance', async () => {
  const result = await scan([target({ targetClass: 'normal', reason: 'ashby_catalog' })]);
  assert.equal(result.candidates[0].sourceMode, 'catalog');
  assert.equal(result.candidates[0].provenance.catalog.rawSha256, 'a'.repeat(64));
});

test('target-specific bounded lookback is passed to provider context', async () => {
  const planned = target({ lookbackStartUtc: '2026-07-18T12:00:00.000Z' });
  await scan([planned]);
  assert.equal(planned._provider.lastContext.sinceMs, Date.parse('2026-07-18T12:00:00.000Z'));
});

test('dead reprobe can explicitly request unbounded listing', async () => {
  const planned = target({ lookbackStartUtc: null, lookbackUnbounded: true });
  await scan([planned]);
  assert.equal(planned._provider.lastContext.sinceMs, undefined);
});

test('manual target without Phase 3 lookback falls back to posting-age window', async () => {
  const planned = target({ lookbackStartUtc: null, lookbackUnbounded: false });
  await scan([planned]);
  assert.equal(
    planned._provider.lastContext.sinceMs,
    Date.parse('2026-06-20T00:00:00.000Z'),
  );
});

test('provider success records raw jobs, retained candidates, status, and HTTP fields', async () => {
  const result = await scan([target({ jobs: [job({ id: '1' }), job({ id: '2' })] })]);
  assert.equal(result.providerResults[0].status, 'ok');
  assert.equal(result.providerResults[0].httpStatus, null);
  assert.equal(result.providerResults[0].jobsReturned, 2);
  assert.equal(result.providerResults[0].candidatesRetained, 2);
});

test('one provider failure does not stop another target', async () => {
  const error = Object.assign(new Error('host unavailable'), { code: 'ENOTFOUND' });
  const result = await scan([
    target({ sequence: 0, tenant: 'failed', error }),
    target({ sequence: 1, tenant: 'successful', jobs: [job({ id: '2' })] }),
  ]);
  assert.equal(result.providerResults[0].errorClass, 'network');
  assert.equal(result.providerResults[1].status, 'ok');
  assert.equal(result.candidates.length, 1);
});

test('404 status is preserved for durable tenant-state decisions', async () => {
  const error = Object.assign(new Error('HTTP 404'), { status: 404 });
  const result = await scan([target({ error })]);
  assert.equal(result.providerResults[0].errorClass, 'http_4xx');
  assert.equal(result.providerResults[0].httpStatus, 404);
});

test('two 429s activate breaker and skip remaining planned targets', async () => {
  const error = Object.assign(new Error('HTTP 429'), { status: 429 });
  const result = await scan([
    target({ sequence: 0, error }),
    target({ sequence: 1, error }),
    target({ sequence: 2, jobs: [job({ id: '3' })] }),
  ], { concurrency: 1 });
  assert.equal(result.breakerEvents[0].reason, 'rate_limit_threshold');
  assert.equal(result.providerResults[2].status, 'skipped');
  assert.equal(result.providerResults[2].skipReason, 'provider_circuit_open');
});

test('cheap filters remain active for planned targets', async () => {
  const result = await scan([target({ jobs: [
    job({ id: '1', title: 'Junior Product Manager' }),
    job({ id: '2', location: 'United States' }),
    job({ id: '3', location: 'Remote Germany' }),
  ] })]);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.rejected.map((item) => item.reason), ['title_filter', 'location_filter']);
});

test('candidate cap remains global across targets', async () => {
  const result = await scan([
    target({ sequence: 0, tenant: 'one', jobs: [job({ id: '1' }), job({ id: '2' })] }),
    target({ sequence: 1, tenant: 'two', jobs: [job({ id: '3' }), job({ id: '4' })] }),
  ], { maxCandidates: 3 });
  assert.equal(result.candidates.length, 3);
  assert.equal(result.providerResults.reduce((sum, item) => sum + item.candidatesMatched, 0), 4);
  assert.equal(result.providerResults.reduce((sum, item) => sum + item.candidatesRetained, 0), 3);
  assert.equal(result.providerResults.reduce((sum, item) => sum + item.candidatesDroppedByCap, 0), 1);
  assert.equal(result.rejected.some((item) => item.reason === 'candidate_cap'), true);
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
]) {
  test(`classifyProviderError maps ${name}`, () => {
    assert.equal(classifyProviderError(error), expected);
  });
}
