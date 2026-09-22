import { getDefaultLocationsV2Catalog } from './locations-v2-catalog.mjs';

function arrangementKey(value) {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/gu, ' ');
  if (normalized.includes('hybrid')) return 'hybrid';
  if (normalized.includes('remote')) return 'remote';
  if (normalized === 'on site' || normalized === 'onsite' || normalized.includes('office')) return 'onSite';
  return 'unknown';
}

function identityKey(item) {
  return `${item.kind}\u0000${item.id}`;
}

function validSelectors(catalog, selectors, warnings, userId, field) {
  const valid = [];
  for (const selector of selectors ?? []) {
    const item = catalog.selectorValid(selector);
    if (!item) {
      warnings.push({
        userId,
        field,
        kind: selector?.kind ?? null,
        locationId: selector?.locationId ?? null,
        reason: 'invalid_or_obsolete_selector',
      });
      continue;
    }
    valid.push(item);
  }
  return valid;
}

function branchMatchesPositive(catalog, directItem, selectorItem, arrangement) {
  const branchFacts = new Set(catalog.facts(directItem).map(identityKey));
  if (branchFacts.has(identityKey(selectorItem))) return true;
  if (arrangement !== 'remote') return false;
  const selectorFacts = new Set(catalog.facts(selectorItem).map(identityKey));
  return selectorFacts.has(identityKey(directItem));
}

function branchMatchesNegative(catalog, directItem, selectorItem) {
  return new Set(catalog.facts(directItem).map(identityKey)).has(identityKey(selectorItem));
}

export function evaluateDiscoveryEligibility(
  candidate,
  user,
  { catalog = getDefaultLocationsV2Catalog(), warnings = [] } = {},
) {
  const eligibility = user.discoveryPreferences?.eligibility;
  if (eligibility == null) {
    return { allowed: true, reason: 'no_geography_restriction', arrangement: arrangementKey(candidate.remoteType) };
  }

  const arrangement = arrangementKey(candidate.remoteType);
  const group = eligibility[arrangement];
  if (!group) return { allowed: false, reason: 'work_arrangement_not_enabled', arrangement };

  const includes = validSelectors(
    catalog,
    group.includeLocations,
    warnings,
    user.userId,
    `eligibility.${arrangement}.includeLocations`,
  );
  const excludes = validSelectors(
    catalog,
    group.excludeLocations,
    warnings,
    user.userId,
    `eligibility.${arrangement}.excludeLocations`,
  );
  if ((group.includeLocations?.length ?? 0) > 0 && includes.length === 0) {
    return { allowed: false, reason: 'no_valid_positive_selector', arrangement };
  }
  if (includes.length === 0 && excludes.length === 0) {
    return { allowed: true, reason: 'no_geography_restriction', arrangement };
  }

  const branches = (candidate.locationsV2 ?? [])
    .map((selector) => catalog.selectorValid(selector))
    .filter(Boolean);
  if (branches.length === 0) {
    return {
      allowed: group.allowUnknownLocation === true,
      reason: group.allowUnknownLocation === true ? 'unknown_location_allowed' : 'unknown_location_rejected',
      arrangement,
    };
  }

  for (const branch of branches) {
    const positive = includes.length === 0
      || includes.some((selector) => branchMatchesPositive(catalog, branch, selector, arrangement));
    if (!positive) continue;
    const negative = excludes.some((selector) => branchMatchesNegative(catalog, branch, selector));
    if (negative) continue;
    return {
      allowed: true,
      reason: 'matching_location_branch',
      arrangement,
      branch: { kind: branch.kind, locationId: branch.id },
    };
  }
  return { allowed: false, reason: 'no_matching_location_branch', arrangement };
}

export function applyDiscoveryEligibility(
  candidates,
  discoveryUsers,
  { catalog = getDefaultLocationsV2Catalog() } = {},
) {
  const userById = new Map(discoveryUsers.map((user) => [user.userId, user]));
  const warnings = [];
  const retained = [];
  const rejected = [];
  const postCounts = new Map();

  for (const candidate of candidates) {
    const matchedUserIds = [];
    const geography = [];
    for (const userId of candidate.matchedUserIds ?? []) {
      const user = userById.get(userId);
      if (!user) continue;
      const result = evaluateDiscoveryEligibility(candidate, user, { catalog, warnings });
      geography.push({ userId, ...result });
      if (result.allowed) {
        matchedUserIds.push(userId);
        postCounts.set(userId, (postCounts.get(userId) ?? 0) + 1);
      }
    }
    candidate.userMatch = { ...(candidate.userMatch ?? {}), geography };
    candidate.matchedUserIds = matchedUserIds.sort();
    if (matchedUserIds.length > 0) retained.push(candidate);
    else rejected.push(candidate);
  }

  return {
    candidates: retained,
    rejected,
    warnings,
    userCounts: Object.fromEntries([...postCounts.entries()].sort()),
  };
}
