const DEFAULT_RESTRICTION_MARKERS = Object.freeze([
  'only',
  'based',
  'residents',
  'resident',
  'located',
  'within',
  'must be',
  'work authorization',
]);

function stringList(value, fallback, name) {
  if (value == null) return [...fallback];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`${name}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matcherFor(value) {
  const normalized = value.trim().toLowerCase();
  const expression = normalized
    .split(/\s+/)
    .map(escapeRegex)
    .join('\\s+');
  return {
    value,
    regex: new RegExp(`(?:^|[^\\p{L}\\p{N}])${expression}(?=$|[^\\p{L}\\p{N}])`, 'iu'),
  };
}

function matches(text, matchers) {
  return matchers
    .filter((item) => item.regex.test(text))
    .map((item) => item.value);
}

function looksLikeRemoteRestriction(text, markers) {
  const lower = text.toLowerCase();
  if (!/\bremote\b/i.test(text)) return false;
  if (/\bremote\b\s*[([,:\-]/i.test(text)) return true;
  return markers.some((marker) => lower.includes(marker.toLowerCase()));
}

export function buildLocationScopeFilter(config) {
  if (config == null) {
    return () => ({
      allowed: true,
      reason: 'not_configured',
      allowedMatches: [],
      blockedMatches: [],
    });
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('location_scope_filter must be an object');
  }
  if (config.enabled === false) {
    return () => ({
      allowed: true,
      reason: 'disabled',
      allowedMatches: [],
      blockedMatches: [],
    });
  }
  if (config.enabled != null && config.enabled !== true) {
    throw new Error('location_scope_filter.enabled must be boolean');
  }

  const allow = stringList(config.allow, [], 'location_scope_filter.allow')
    .map(matcherFor);
  const block = stringList(config.block, [], 'location_scope_filter.block')
    .map(matcherFor);
  const markers = stringList(
    config.restriction_markers,
    DEFAULT_RESTRICTION_MARKERS,
    'location_scope_filter.restriction_markers',
  );

  return (rawLocation) => {
    const raw = typeof rawLocation === 'string' ? rawLocation.trim() : '';
    if (raw === '') {
      return {
        allowed: true,
        reason: 'missing_scope',
        allowedMatches: [],
        blockedMatches: [],
      };
    }

    const allowedMatches = matches(raw, allow);
    const blockedMatches = matches(raw, block);

    /*
     * An explicit compatible region wins over a blocked region because ATS
     * feeds often list several allowed regions together, for example
     * "Remote (US or Europe)". We reject only clearly exclusive scopes.
     */
    if (allowedMatches.length > 0) {
      return {
        allowed: true,
        reason: 'compatible_scope_present',
        allowedMatches,
        blockedMatches,
      };
    }

    if (blockedMatches.length === 0) {
      return {
        allowed: true,
        reason: 'no_blocked_scope',
        allowedMatches,
        blockedMatches,
      };
    }

    const lower = raw.toLowerCase();
    const markerMatches = markers.filter((marker) => (
      lower.includes(marker.toLowerCase())
    ));
    if (looksLikeRemoteRestriction(raw, markers) || markerMatches.length > 0) {
      return {
        allowed: false,
        reason: 'explicit_blocked_remote_scope',
        allowedMatches,
        blockedMatches,
        markerMatches,
      };
    }

    return {
      allowed: true,
      reason: 'blocked_scope_not_explicitly_restrictive',
      allowedMatches,
      blockedMatches,
    };
  };
}
