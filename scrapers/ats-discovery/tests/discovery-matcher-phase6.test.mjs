import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDiscoveryMatcher,
  buildUserMatchArtifact,
  selectDiscoveryExecutionTargets,
} from '../src/users/discovery-matcher.mjs';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

function user(userId, title, eligibility = null) {
  return {
    userId,
    cvVersionId: `${userId.slice(0, 8)}-cv`,
    discoveryPreferencesInvalid: false,
    discoveryPreferences: {
      schemaVersion: 1,
      title: { positive: [], positivePatterns: [], negative: [], ...title },
      eligibility,
    },
  };
}

function candidate(title = 'Senior Product Manager') {
  return {
    title,
    url: 'https://example.test/job/1',
    sourceProvider: 'greenhouse',
    sourceTenant: 'example',
  };
}

test('missing preferences and negative-only titles do not enable discovery', () => {
  const matcher = buildDiscoveryMatcher({ users: [
    { userId: USER_A, cvVersionId: 'a', discoveryPreferences: null, discoveryPreferencesInvalid: false },
    user(USER_B, { negative: ['Intern'] }),
  ] });
  assert.equal(matcher.enabledUsers.length, 0);
  assert.equal(matcher.compoundedProfile.usersDisabledNoPositiveTitle, 2);
  assert.equal(matcher.matchCandidate(candidate()).allowed, false);
});

test('positive phrases and orderedGap patterns use OR semantics with negative veto', () => {
  const matcher = buildDiscoveryMatcher({ users: [user(USER_A, {
    positive: ['Product Owner'],
    positivePatterns: [{
      type: 'orderedGap', left: ['Engineering'], right: ['Manager', 'Lead'], maxGapWords: 2,
    }],
    negative: ['Intern'],
  })] });
  assert.equal(matcher.matchCandidate(candidate('Product Owner')).allowed, true);
  assert.equal(matcher.matchCandidate(candidate('Senior Engineering Platform Manager')).allowed, true);
  assert.equal(matcher.matchCandidate(candidate('Engineering Global Platform Operations Manager')).allowed, false);
  assert.equal(matcher.matchCandidate(candidate('Engineering Team Lead Intern')).allowed, false);
});

test('title token matching tolerates punctuation, case, and Unicode words', () => {
  const matcher = buildDiscoveryMatcher({ users: [user(USER_A, {
    positive: ['Produkt Manager'],
    positivePatterns: [{
      type: 'orderedGap', left: ['Technische'], right: ['Leitung'], maxGapWords: 2,
    }],
  })] });
  assert.equal(matcher.matchCandidate(candidate('PRODUKT-MANAGER')).allowed, true);
  assert.equal(matcher.matchCandidate(candidate('Technische Plattform Leitung')).allowed, true);
});

test('users use union semantics and retain structured title evidence', () => {
  const matcher = buildDiscoveryMatcher({ users: [
    user(USER_A, { positive: ['Product Manager'] }),
    user(USER_B, { positivePatterns: [{
      type: 'orderedGap', left: ['Product'], right: ['Manager'], maxGapWords: 2,
    }] }),
  ] });
  const result = matcher.matchCandidate(candidate());
  assert.deepEqual(result.matchedUserIds, [USER_A, USER_B]);
  assert.equal(result.matchedTitles[1].patternMatches[0].pattern.type, 'orderedGap');
});

test('invalid stored preferences disable one user', () => {
  const matcher = buildDiscoveryMatcher({ users: [{
    userId: USER_A,
    cvVersionId: 'a',
    discoveryPreferences: null,
    discoveryPreferencesInvalid: true,
    discoveryPreferencesError: 'bad row',
  }] });
  assert.equal(matcher.enabledUsers.length, 0);
  assert.equal(matcher.userArtifact[0].discoveryStatus, 'disabled_invalid_preferences');
});

test('user-match artifact preserves structured explainability', () => {
  const matcher = buildDiscoveryMatcher({ users: [user(USER_A, { positive: ['Product Manager'] })] });
  const match = matcher.matchCandidate(candidate());
  const job = { ...candidate(), matchedUserIds: match.matchedUserIds, userMatch: { matchedTitles: match.matchedTitles } };
  const artifact = buildUserMatchArtifact({ discoveryMatcher: matcher, candidates: [job], rejected: [] });
  assert.equal(artifact.users[0].matchingEnabled, true);
  assert.deepEqual(artifact.matches[0].matchedTitles[0].positiveMatches, ['Product Manager']);
});

test('no discovery-enabled users suppress candidate targets but preserve provider canaries', () => {
  const canary = { sequence: 0, healthOnly: true };
  const priority = { sequence: 1, healthOnly: false };
  const selected = selectDiscoveryExecutionTargets({
    runtimeTargets: [canary, priority], multiUserEnabled: true, discoveryUsers: [],
  });
  assert.deepEqual(selected.executionTargets, [canary]);
  assert.equal(selected.targetsSkippedNoEligibleUsers, 1);
});
