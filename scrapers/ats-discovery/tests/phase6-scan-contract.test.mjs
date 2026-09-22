import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDiscoveryPolicy } from '../src/policy/discovery-policy.mjs';
import { admitCandidatesFairly, runTrackedScan } from '../src/scan/tracked-source.mjs';

function policy() {
  return parseDiscoveryPolicy({
    schema_version: 1,
    defaults: {
      execution: {
        concurrency: 1,
        min_request_interval_ms: 0,
      },
    },
    providers: { ashby: { catalog_enabled: false } },
  });
}

function makeTarget(jobs) {
  const provider = {
    id: 'ashby',
    source: {
      repository: 'santifer/career-ops',
      file: 'providers/ashby.mjs',
      ref: 'x',
      license: 'MIT',
    },
    async fetch() { return jobs; },
  };
  return {
    sequence: 0,
    provider: 'ashby',
    tenant: 'example',
    name: 'Example',
    careers_url: 'https://jobs.ashbyhq.com/example',
    sourceOrigin: 'https://jobs.ashbyhq.com',
    targetClass: 'priority',
    reason: 'tracked_company',
    _provider: provider,
  };
}

function job(id) {
  return {
    id: String(id),
    title: 'Product Manager',
    company: 'Example',
    location: 'Berlin, Germany',
    description: 'Product role',
    postedAt: Date.parse('2026-07-24T00:00:00Z'),
    url: `https://example.test/jobs/${id}`,
  };
}

test('user matching happens before the global candidate cap', async () => {
  const target = makeTarget([job(1), job(2), job(3)]);
  const result = await runTrackedScan({
    portalConfig: {
      title_filter: { positive: ['Product Manager'] },
      location_filter: { allow: ['Germany'] },
      max_posting_age_days: 30,
    },
    targets: [target],
    providers: new Map([['ashby', target._provider]]),
    policy: policy(),
    concurrency: 1,
    maxCandidates: 1,
    upstreamRef: 'ref',
    nowMs: Date.parse('2026-07-24T12:00:00Z'),
    monotonicNow: (() => { let tick = 0; return () => ++tick; })(),
    sleep: async () => {},
    httpContextFactory: () => ({}),
    candidateMatcher: (candidate) => candidate.url.endsWith('/3')
      ? {
        allowed: true,
        matchedUserIds: ['11111111-1111-4111-8111-111111111111'],
        matchedProfiles: [{
          userId: '11111111-1111-4111-8111-111111111111',
          profileId: null,
        }],
      }
      : { allowed: false, matchedUserIds: [], matchedProfiles: [] },
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].url.endsWith('/3'), true);
  assert.deepEqual(result.candidates[0].matchedUserIds, [
    '11111111-1111-4111-8111-111111111111',
  ]);
  assert.equal(result.rejected.filter((item) => item.reason === 'no_user_match').length, 2);
  assert.equal(result.rejected.some((item) => item.reason === 'candidate_cap'), false);
});

test('candidate matcher errors reject one candidate without aborting the provider', async () => {
  const target = makeTarget([job(1), job(2)]);
  const result = await runTrackedScan({
    portalConfig: { max_posting_age_days: 30 },
    targets: [target],
    providers: new Map([['ashby', target._provider]]),
    policy: policy(),
    concurrency: 1,
    maxCandidates: 10,
    upstreamRef: 'ref',
    nowMs: Date.parse('2026-07-24T12:00:00Z'),
    monotonicNow: (() => { let tick = 0; return () => ++tick; })(),
    sleep: async () => {},
    httpContextFactory: () => ({}),
    candidateMatcher: (candidate) => {
      if (candidate.url.endsWith('/1')) throw new Error('bad profile');
      return {
        allowed: true,
        matchedUserIds: ['11111111-1111-4111-8111-111111111111'],
        matchedProfiles: [],
      };
    },
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.rejected[0].reason, 'user_match_error');
});

test('multi-user mode bypasses all legacy portal preference filters but preserves age safety', async () => {
  const target = makeTarget([
    {
      ...job(1),
      title: 'Engineering Manager',
      location: 'Munich, Germany',
      description: 'Engineering leadership',
    },
    {
      ...job(2),
      title: 'Engineering Manager',
      location: 'Remote — United States only',
      description: 'Engineering leadership',
    },
  ]);
  const result = await runTrackedScan({
    portalConfig: {
      title_filter: { positive: ['Product Manager'] },
      location_filter: { allow: ['Berlin'] },
      location_scope_filter: {
        allow: ['Germany', 'Europe', 'Global'],
        block: ['United States', 'US', 'USA'],
        restriction_markers: ['only'],
      },
      salary_filter: { minimum: 999999 },
      content_filter: { require_any: ['nonexistent phrase'] },
      max_posting_age_days: 30,
    },
    targets: [target],
    providers: new Map([['ashby', target._provider]]),
    policy: policy(),
    concurrency: 1,
    maxCandidates: 10,
    upstreamRef: 'ref',
    nowMs: Date.parse('2026-07-24T12:00:00Z'),
    monotonicNow: (() => { let tick = 0; return () => ++tick; })(),
    sleep: async () => {},
    httpContextFactory: () => ({}),
    applyPortalCandidateFilters: false,
    candidateMatcher: () => ({
      allowed: true,
      matchedUserIds: ['11111111-1111-4111-8111-111111111111'],
      matchedProfiles: [],
    }),
  });

  assert.equal(result.candidates.length, 2);
  assert.equal(
    result.rejected.some((item) => item.reason === 'title_filter'),
    false,
  );
  assert.equal(
    result.rejected.some((item) => item.reason === 'location_filter'),
    false,
  );
  assert.equal(
    result.rejected.some((item) => item.reason === 'salary_filter'),
    false,
  );
  assert.equal(
    result.rejected.some((item) => item.reason === 'content_filter'),
    false,
  );
  assert.equal(
    result.rejected.some((item) => item.reason === 'location_scope_filter'),
    false,
  );
});

test('portal candidate filter switch is strictly boolean', async () => {
  const target = makeTarget([job(1)]);
  await assert.rejects(
    runTrackedScan({
      portalConfig: { max_posting_age_days: 30 },
      targets: [target],
      providers: new Map([['ashby', target._provider]]),
      policy: policy(),
      concurrency: 1,
      maxCandidates: 10,
      upstreamRef: 'ref',
      applyPortalCandidateFilters: 'no',
    }),
    /applyPortalCandidateFilters must be a boolean/,
  );
});


test('fair admission prevents one broad user from consuming all candidate slots', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const C = '33333333-3333-4333-8333-333333333333';
  const candidates = [
    ...Array.from({ length: 10 }, (_, index) => ({ url: `a${index}`, sourceMode: 'catalog', matchedUserIds: [A] })),
    { url: 'b', sourceMode: 'catalog', matchedUserIds: [B] },
    { url: 'c', sourceMode: 'catalog', matchedUserIds: [C] },
  ];
  const result = admitCandidatesFairly(candidates, 3, { fairnessSeed: 'run' });
  const served = new Set(result.retained.flatMap((item) => item.matchedUserIds));
  assert.deepEqual(served, new Set([A, B, C]));
  assert.equal(result.stats.usersStarvedByCandidateCap, 0);
});

test('fair admission prefers priority candidates inside each user queue', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const candidates = [
    { url: 'a-catalog', sourceMode: 'catalog', matchedUserIds: [A] },
    { url: 'a-priority', sourceMode: 'priority', matchedUserIds: [A] },
    { url: 'b', sourceMode: 'catalog', matchedUserIds: [B] },
  ];
  const result = admitCandidatesFairly(candidates, 2, { fairnessSeed: 'run' });
  assert.equal(result.retained.some((item) => item.url === 'a-priority'), true);
  assert.equal(result.retained.some((item) => item.url === 'b'), true);
});

test('fair admission order is kept for downstream create limits', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const C = '33333333-3333-4333-8333-333333333333';
  const candidates = [
    ...Array.from({ length: 5 }, (_, index) => ({ url: `a${index}`, sourceMode: 'catalog', matchedUserIds: [A] })),
    { url: 'b', sourceMode: 'catalog', matchedUserIds: [B] },
    { url: 'c', sourceMode: 'catalog', matchedUserIds: [C] },
  ];
  const result = admitCandidatesFairly(candidates, 3, { fairnessSeed: 'run' });
  assert.deepEqual(
    new Set(result.retained.slice(0, 3).flatMap((item) => item.matchedUserIds)),
    new Set([A, B, C]),
  );
});

test('shared candidate serves all matched users in the same fairness round', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const candidates = [
    { url: 'shared', sourceMode: 'priority', matchedUserIds: [A, B] },
    { url: 'a-only', sourceMode: 'catalog', matchedUserIds: [A] },
    { url: 'b-only', sourceMode: 'catalog', matchedUserIds: [B] },
  ];
  const result = admitCandidatesFairly(candidates, 2, { fairnessSeed: 'run' });
  assert.equal(result.retained[0].url, 'shared');
  assert.equal(result.retained.length, 2);
});
