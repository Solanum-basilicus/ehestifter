const MAX_USER_DIAGNOSTICS = 20;
const MAX_LOCATION_CLAIMS = 25;
const MAX_UNRESOLVED = 10;
const MAX_RAW_LENGTH = 160;

export function geographyRejectionDetails(candidate, { phase = 'final' } = {}) {
  const geography = candidate?.userMatch?.geography
    ?? candidate?.userMatch?.preliminaryGeography
    ?? [];
  const locationsV2 = candidate?.locationsV2 ?? [];
  return {
    phase,
    matchedUserCountBeforeLocation: geography.length,
    matchedUserIdsBeforeLocation: geography
      .slice(0, MAX_USER_DIAGNOSTICS)
      .map((item) => item.userId),
    geographyCount: geography.length,
    geography: geography.slice(0, MAX_USER_DIAGNOSTICS).map((item) => ({
      userId: item.userId,
      allowed: item.allowed,
      reason: item.reason,
      arrangement: item.arrangement,
      branch: item.branch ?? null,
    })),
    locationsV2Count: locationsV2.length,
    locationsV2: locationsV2.slice(0, MAX_LOCATION_CLAIMS),
    locationNormalization: candidate?.locationNormalization ? {
      status: candidate.locationNormalization.status ?? null,
      consistency: candidate.locationNormalization.consistency ?? null,
      unresolved: (candidate.locationNormalization.unresolved ?? [])
        .slice(0, MAX_UNRESOLVED)
        .map((item) => ({
          source: item.source ?? null,
          raw: typeof item.raw === 'string' ? item.raw.slice(0, MAX_RAW_LENGTH) : null,
          reason: item.reason ?? null,
        })),
    } : null,
  };
}
