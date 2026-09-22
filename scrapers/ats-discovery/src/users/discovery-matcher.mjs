function tokenize(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function phraseTokens(value) {
  return tokenize(value);
}

function phrasePositions(tokens, phrase) {
  if (phrase.length === 0 || phrase.length > tokens.length) return [];
  const output = [];
  for (let index = 0; index <= tokens.length - phrase.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < phrase.length; offset += 1) {
      if (tokens[index + offset] !== phrase[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) output.push({ start: index, end: index + phrase.length });
  }
  return output;
}

function phraseMatches(tokens, value) {
  return phrasePositions(tokens, phraseTokens(value)).length > 0;
}

function orderedGapMatches(tokens, pattern) {
  for (const leftValue of pattern.left) {
    const leftTokens = phraseTokens(leftValue);
    for (const left of phrasePositions(tokens, leftTokens)) {
      for (const rightValue of pattern.right) {
        const rightTokens = phraseTokens(rightValue);
        for (const right of phrasePositions(tokens, rightTokens)) {
          if (right.start < left.end) continue;
          const gap = right.start - left.end;
          if (gap <= pattern.maxGapWords) {
            return { left: leftValue, right: rightValue, gapWords: gap };
          }
        }
      }
    }
  }
  return null;
}

function compileTitle(preferences) {
  const title = preferences?.title ?? {};
  const positive = Array.isArray(title.positive) ? title.positive : [];
  const positivePatterns = Array.isArray(title.positivePatterns) ? title.positivePatterns : [];
  const negative = Array.isArray(title.negative) ? title.negative : [];
  return {
    enabled: positive.length > 0 || positivePatterns.length > 0,
    evaluate(value) {
      const tokens = tokenize(value);
      const negativeMatches = negative.filter((term) => phraseMatches(tokens, term));
      if (negativeMatches.length > 0) {
        return {
          allowed: false,
          positiveMatches: [],
          patternMatches: [],
          negativeMatches,
        };
      }
      const positiveMatches = positive.filter((term) => phraseMatches(tokens, term));
      const patternMatches = [];
      positivePatterns.forEach((pattern, index) => {
        const evidence = orderedGapMatches(tokens, pattern);
        if (evidence) {
          patternMatches.push({ index, pattern, ...evidence });
        }
      });
      return {
        allowed: positiveMatches.length > 0 || patternMatches.length > 0,
        positiveMatches,
        patternMatches,
        negativeMatches,
      };
    },
  };
}

function discoveryStatus(user) {
  if (user.discoveryPreferencesInvalid) return 'disabled_invalid_preferences';
  if (!user.discoveryPreferences) return 'disabled_no_positive_title';
  const compiled = compileTitle(user.discoveryPreferences);
  return compiled.enabled ? 'enabled' : 'disabled_no_positive_title';
}

export function buildDiscoveryMatcher(usersPayload) {
  const compiledUsers = usersPayload.users.map((user) => {
    const status = discoveryStatus(user);
    return {
      ...user,
      discoveryStatus: status,
      compiledTitle: status === 'enabled'
        ? compileTitle(user.discoveryPreferences)
        : null,
    };
  });
  const enabledUsers = compiledUsers.filter((user) => user.discoveryStatus === 'enabled');

  const userArtifact = compiledUsers.map((user) => ({
    userId: user.userId,
    cvVersionId: user.cvVersionId,
    cvLastUpdatedUtc: user.cvLastUpdatedUtc,
    discoveryStatus: user.discoveryStatus,
    discoveryPreferencesInvalid: user.discoveryPreferencesInvalid,
    discoveryPreferencesError: user.discoveryPreferencesError ?? null,
    matchingEnabled: user.discoveryStatus === 'enabled',
  }));

  const compoundedProfile = {
    schemaVersion: 2,
    eligibleUsers: compiledUsers.length,
    discoveryEnabledUsers: enabledUsers.length,
    usersDisabledNoPositiveTitle: compiledUsers.filter(
      (user) => user.discoveryStatus === 'disabled_no_positive_title',
    ).length,
    usersDisabledInvalidPreferences: compiledUsers.filter(
      (user) => user.discoveryStatus === 'disabled_invalid_preferences',
    ).length,
  };

  function matchCandidate(candidate) {
    const matchedUserIds = [];
    const matchedTitles = [];
    for (const user of enabledUsers) {
      const evaluation = user.compiledTitle.evaluate(candidate.title);
      if (!evaluation.allowed) continue;
      matchedUserIds.push(user.userId);
      matchedTitles.push({
        userId: user.userId,
        positiveMatches: evaluation.positiveMatches,
        patternMatches: evaluation.patternMatches,
      });
    }
    matchedUserIds.sort((left, right) => left.localeCompare(right));
    matchedTitles.sort((left, right) => left.userId.localeCompare(right.userId));
    return {
      allowed: matchedUserIds.length > 0,
      matchedUserIds,
      matchedProfiles: [],
      matchedTitles,
    };
  }

  return {
    sourceGeneratedAtUtc: usersPayload.generatedAtUtc ?? null,
    users: compiledUsers.map(({ compiledTitle, ...user }) => user),
    enabledUsers: enabledUsers.map(({ compiledTitle, ...user }) => user),
    userArtifact,
    compoundedProfile,
    matchCandidate,
  };
}

export function buildUserMatchArtifact({ discoveryMatcher, candidates, rejected }) {
  return {
    schemaVersion: 2,
    sourceGeneratedAtUtc: discoveryMatcher.sourceGeneratedAtUtc,
    compoundedProfile: discoveryMatcher.compoundedProfile,
    users: discoveryMatcher.userArtifact,
    matches: candidates.map((candidate) => ({
      url: candidate.url,
      sourceProvider: candidate.sourceProvider,
      sourceTenant: candidate.sourceTenant,
      matchedUserIds: candidate.matchedUserIds ?? [],
      matchedTitles: candidate.userMatch?.matchedTitles ?? [],
      geography: candidate.userMatch?.geography ?? [],
    })),
    rejectedNoUserMatch: rejected
      .filter((item) => item.reason === 'no_user_match')
      .map((item) => ({
        url: item.candidate?.url ?? item.details?.url ?? null,
        sourceProvider: item.candidate?.sourceProvider ?? null,
        sourceTenant: item.candidate?.sourceTenant ?? null,
      })),
  };
}

export function selectDiscoveryExecutionTargets({
  runtimeTargets,
  multiUserEnabled,
  discoveryUsers,
}) {
  if (!Array.isArray(runtimeTargets)) throw new Error('runtimeTargets must be an array');
  if (typeof multiUserEnabled !== 'boolean') throw new Error('multiUserEnabled must be a boolean');
  if (!multiUserEnabled) {
    return {
      executionTargets: runtimeTargets,
      targetsSkippedNoEligibleUsers: 0,
      hasEligibleUsers: null,
    };
  }
  const users = Array.isArray(discoveryUsers) ? discoveryUsers : [];
  if (users.length > 0) {
    return {
      executionTargets: runtimeTargets,
      targetsSkippedNoEligibleUsers: 0,
      hasEligibleUsers: true,
    };
  }
  const executionTargets = runtimeTargets.filter((target) => target.healthOnly);
  return {
    executionTargets,
    targetsSkippedNoEligibleUsers: runtimeTargets.length - executionTargets.length,
    hasEligibleUsers: false,
  };
}
