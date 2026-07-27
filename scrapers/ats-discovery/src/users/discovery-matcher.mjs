import {
  buildLocationFilter,
  buildTitleEvaluator,
  compileKeyword,
} from '../scan/filters.mjs';

function normalizeRemoteType(value) {
  const lower = String(value ?? '').trim().toLowerCase();
  if (!lower) return 'unknown';
  if (lower.includes('hybrid')) return 'hybrid';
  if (lower.includes('remote')) return 'remote';
  if (
    lower.includes('on-site')
    || lower.includes('onsite')
    || lower.includes('on site')
    || lower.includes('office')
  ) return 'onsite';
  return lower.replace(/[^a-z0-9]+/g, '_');
}

function compileCompanyFilter(config) {
  const compile = (items) => (Array.isArray(items) ? items : [])
    .map((keyword) => ({ keyword, matcher: compileKeyword(keyword) }));
  const allow = compile(config?.allow);
  const block = compile(config?.block);
  return (company) => {
    const lower = String(company ?? '').toLowerCase();
    const blocked = block.filter((entry) => entry.matcher(lower));
    const allowed = allow.filter((entry) => entry.matcher(lower));
    return {
      allowed: blocked.length === 0 && (allow.length === 0 || allowed.length > 0),
      allowMatches: allowed.map((entry) => entry.keyword),
      blockMatches: blocked.map((entry) => entry.keyword),
    };
  };
}

function candidateLocationText(candidate) {
  const parts = [candidate.rawLocation, candidate.remoteType];
  for (const location of Array.isArray(candidate.locations) ? candidate.locations : []) {
    if (typeof location === 'string') {
      parts.push(location);
      continue;
    }
    if (!location || typeof location !== 'object') continue;
    parts.push(
      location.raw,
      location.city,
      location.region,
      location.country,
      location.countryCode,
    );
  }
  return parts.filter((value) => typeof value === 'string' && value.trim()).join(' | ');
}

function compileProfile(profile) {
  const title = buildTitleEvaluator(profile.title);
  const location = buildLocationFilter({
    always_allow: profile.location?.alwaysAllow,
    allow: profile.location?.allow,
    block: profile.location?.block,
  });
  const company = compileCompanyFilter(profile.company);
  const remoteTypes = new Set(
    (profile.remoteTypes ?? []).map(normalizeRemoteType),
  );

  return {
    profileId: profile.profileId ?? null,
    evaluate(candidate) {
      const titleResult = title(candidate.title);
      if (!titleResult.allowed) return { allowed: false, reason: 'title' };
      const locationText = candidateLocationText(candidate);
      if (!location(locationText)) return { allowed: false, reason: 'location' };
      const companyResult = company(candidate.hiringCompanyName);
      if (!companyResult.allowed) return { allowed: false, reason: 'company' };
      if (
        remoteTypes.size > 0
        && !remoteTypes.has(normalizeRemoteType(candidate.remoteType))
      ) {
        return { allowed: false, reason: 'remote_type' };
      }
      return {
        allowed: true,
        reason: null,
        titleMatches: titleResult.positiveMatches,
        companyMatches: companyResult.allowMatches,
      };
    },
  };
}

export function buildDiscoveryMatcher(usersPayload) {
  const compiledUsers = usersPayload.users.map((user) => {
    let profiles;
    if (user.profiles.length > 0) {
      profiles = user.profiles.map(compileProfile);
    } else if (!user.hasSavedFilters) {
      profiles = [{
        profileId: null,
        evaluate: () => ({ allowed: true, reason: null }),
      }];
    } else {
      /* Saved filters existed but none could be normalized: fail closed. */
      profiles = [];
    }
    return { ...user, compiledProfiles: profiles };
  });

  const userArtifact = compiledUsers.map((user) => ({
    userId: user.userId,
    cvVersionId: user.cvVersionId,
    cvLastUpdatedUtc: user.cvLastUpdatedUtc,
    hasSavedFilters: user.hasSavedFilters,
    validProfileCount: user.profiles.length,
    invalidProfileCount: user.invalidProfileCount,
    matchingEnabled: user.compiledProfiles.length > 0,
  }));

  const compoundedProfile = {
    schemaVersion: 1,
    eligibleUsers: compiledUsers.length,
    usersWithSavedFilters: compiledUsers.filter((user) => user.hasSavedFilters).length,
    usersWithValidProfiles: compiledUsers.filter((user) => user.profiles.length > 0).length,
    usersFailingClosed: compiledUsers.filter(
      (user) => user.hasSavedFilters && user.compiledProfiles.length === 0,
    ).length,
    profileCount: compiledUsers.reduce(
      (total, user) => total + user.profiles.length,
      0,
    ),
  };

  function matchCandidate(candidate) {
    const matchedUserIds = [];
    const matchedProfiles = [];
    for (const user of compiledUsers) {
      const profile = user.compiledProfiles.find(
        (item) => item.evaluate(candidate).allowed,
      );
      if (!profile) continue;
      matchedUserIds.push(user.userId);
      matchedProfiles.push({
        userId: user.userId,
        profileId: profile.profileId,
      });
    }
    matchedUserIds.sort((left, right) => left.localeCompare(right));
    matchedProfiles.sort((left, right) => (
      left.userId.localeCompare(right.userId)
      || String(left.profileId ?? '').localeCompare(String(right.profileId ?? ''))
    ));
    return {
      allowed: matchedUserIds.length > 0,
      matchedUserIds,
      matchedProfiles,
    };
  }

  return {
    sourceGeneratedAtUtc: usersPayload.generatedAtUtc ?? null,
    users: compiledUsers.map(({ compiledProfiles, ...user }) => user),
    userArtifact,
    compoundedProfile,
    matchCandidate,
  };
}

export function buildUserMatchArtifact({
  discoveryMatcher,
  candidates,
  rejected,
}) {
  return {
    schemaVersion: 1,
    sourceGeneratedAtUtc: discoveryMatcher.sourceGeneratedAtUtc,
    compoundedProfile: discoveryMatcher.compoundedProfile,
    users: discoveryMatcher.userArtifact,
    matches: candidates.map((candidate) => ({
      url: candidate.url,
      sourceProvider: candidate.sourceProvider,
      sourceTenant: candidate.sourceTenant,
      matchedUserIds: candidate.matchedUserIds ?? [],
      matchedProfiles: candidate.userMatch?.matchedProfiles ?? [],
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
  if (!Array.isArray(runtimeTargets)) {
    throw new Error('runtimeTargets must be an array');
  }
  if (typeof multiUserEnabled !== 'boolean') {
    throw new Error('multiUserEnabled must be a boolean');
  }
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
