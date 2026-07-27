import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDiscoveryMatcher,
  buildUserMatchArtifact,
  selectDiscoveryExecutionTargets,
} from '../src/users/discovery-matcher.mjs';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const CV_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CV_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function candidate(overrides = {}) {
  return {
    title: 'Senior Product Manager',
    hiringCompanyName: 'Celonis',
    rawLocation: 'Munich, Germany (Hybrid)',
    locations: [],
    remoteType: 'Hybrid',
    url: 'https://example.test/job/1',
    sourceProvider: 'greenhouse',
    sourceTenant: 'celonis',
    ...overrides,
  };
}

test('saved profiles use OR semantics per user and users use union semantics', () => {
  const matcher = buildDiscoveryMatcher({
    users: [
      {
        userId: USER_A,
        cvVersionId: CV_A,
        hasSavedFilters: true,
        invalidProfileCount: 0,
        profiles: [
          {
            profileId: 'a1',
            title: { positive: ['Engineering Manager'], negative: [] },
            location: { alwaysAllow: [], allow: [], block: [] },
            company: { allow: [], block: [] },
            remoteTypes: [],
          },
          {
            profileId: 'a2',
            title: { positive: ['Product Manager'], negative: ['Intern'] },
            location: { alwaysAllow: ['Germany'], allow: [], block: [] },
            company: { allow: ['Celonis'], block: [] },
            remoteTypes: ['Hybrid'],
          },
        ],
      },
      {
        userId: USER_B,
        cvVersionId: CV_B,
        hasSavedFilters: false,
        invalidProfileCount: 0,
        profiles: [],
      },
    ],
  });

  const result = matcher.matchCandidate(candidate());
  assert.equal(result.allowed, true);
  assert.deepEqual(result.matchedUserIds, [USER_A, USER_B]);
  assert.deepEqual(result.matchedProfiles, [
    { userId: USER_A, profileId: 'a2' },
    { userId: USER_B, profileId: null },
  ]);
});

test('a user with malformed saved filters fails closed instead of matching all', () => {
  const matcher = buildDiscoveryMatcher({
    users: [{
      userId: USER_A,
      cvVersionId: CV_A,
      hasSavedFilters: true,
      invalidProfileCount: 1,
      profiles: [],
    }],
  });
  assert.deepEqual(matcher.matchCandidate(candidate()), {
    allowed: false,
    matchedUserIds: [],
    matchedProfiles: [],
  });
  assert.equal(matcher.compoundedProfile.usersFailingClosed, 1);
});

test('title, company, location, and remote constraints are all cheap gates', () => {
  const profile = {
    profileId: 'p',
    title: { positive: ['Product Manager'], negative: ['Junior'] },
    location: { alwaysAllow: [], allow: ['Germany'], block: ['US only'] },
    company: { allow: ['Celonis'], block: ['Agency'] },
    remoteTypes: ['Hybrid'],
  };
  const matcher = buildDiscoveryMatcher({
    users: [{
      userId: USER_A,
      cvVersionId: CV_A,
      hasSavedFilters: true,
      invalidProfileCount: 0,
      profiles: [profile],
    }],
  });
  assert.equal(matcher.matchCandidate(candidate()).allowed, true);
  assert.equal(matcher.matchCandidate(candidate({ title: 'Junior Product Manager' })).allowed, false);
  assert.equal(matcher.matchCandidate(candidate({ hiringCompanyName: 'Example Agency' })).allowed, false);
  assert.equal(matcher.matchCandidate(candidate({ rawLocation: 'US only' })).allowed, false);
  assert.equal(matcher.matchCandidate(candidate({ remoteType: 'Remote' })).allowed, false);
});

test('user-match artifact contains identifiers and counts but no filter terms', () => {
  const matcher = buildDiscoveryMatcher({
    users: [{
      userId: USER_A,
      cvVersionId: CV_A,
      cvLastUpdatedUtc: '2026-07-24T00:00:00Z',
      hasSavedFilters: false,
      invalidProfileCount: 0,
      profiles: [],
    }],
  });
  const job = {
    ...candidate(),
    matchedUserIds: [USER_A],
    userMatch: { matchedProfiles: [{ userId: USER_A, profileId: null }] },
  };
  const artifact = buildUserMatchArtifact({
    discoveryMatcher: matcher,
    candidates: [job],
    rejected: [{ reason: 'no_user_match', candidate: candidate({ url: 'https://example.test/job/2' }) }],
  });
  assert.equal(artifact.users[0].validProfileCount, 0);
  assert.deepEqual(artifact.matches[0].matchedUserIds, [USER_A]);
  assert.equal(JSON.stringify(artifact).includes('Product Manager'), false);
  assert.equal(artifact.rejectedNoUserMatch.length, 1);
});


test('no eligible users suppress candidate targets but preserve provider canaries', () => {
  const canary = { sequence: 0, healthOnly: true };
  const priority = { sequence: 1, healthOnly: false };
  const normal = { sequence: 2 };
  const selected = selectDiscoveryExecutionTargets({
    runtimeTargets: [canary, priority, normal],
    multiUserEnabled: true,
    discoveryUsers: [],
  });
  assert.deepEqual(selected.executionTargets, [canary]);
  assert.equal(selected.targetsSkippedNoEligibleUsers, 2);
  assert.equal(selected.hasEligibleUsers, false);

  const disabled = selectDiscoveryExecutionTargets({
    runtimeTargets: [canary, priority, normal],
    multiUserEnabled: false,
    discoveryUsers: [],
  });
  assert.equal(disabled.executionTargets.length, 3);
  assert.equal(disabled.targetsSkippedNoEligibleUsers, 0);
  assert.equal(disabled.hasEligibleUsers, null);
});
