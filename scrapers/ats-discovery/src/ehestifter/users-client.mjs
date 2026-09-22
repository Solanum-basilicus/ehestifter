function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function uuidLike(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function boundedVersionId(value, name) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized === '' || normalized.length > 128 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${name} must be a nonempty bounded version identifier`);
  }
  return normalized;
}

function optionalTimestamp(value, name) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 80) {
    throw new Error(`${name} must be a bounded timestamp string`);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`${name} must be a valid timestamp`);
  return new Date(parsed).toISOString();
}

function normalizeText(value, name) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (!normalized || normalized.length > 120) {
    throw new Error(`${name} must be a nonempty string of at most 120 characters`);
  }
  return normalized;
}

function stringArray(value, name, maxItems) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  if (value.length > maxItems) throw new Error(`${name} exceeds ${maxItems} items`);
  return value.map((item, index) => normalizeText(item, `${name}[${index}]`));
}

function patternTerms(value, name) {
  const terms = stringArray(value, name, 10);
  if (terms.length === 0) throw new Error(`${name} must not be empty`);
  return terms;
}

function selector(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const kind = value.kind;
  const locationId = typeof value.locationId === 'string' ? value.locationId.trim() : '';
  if (!['city', 'adminRegion', 'country', 'globalRegion'].includes(kind)) {
    throw new Error(`${name}.kind is invalid`);
  }
  if (!locationId || locationId.length > 64) {
    throw new Error(`${name}.locationId is invalid`);
  }
  return { kind, locationId };
}

function selectors(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  if (value.length > 100) throw new Error(`${name} exceeds 100 items`);
  return value.map((item, index) => selector(item, `${name}[${index}]`));
}

function ranges(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  if (value.length > 32) throw new Error(`${name} exceeds 32 items`);
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${name}[${index}] must be an object`);
    }
    const start = item.startMinutes;
    const end = item.endMinutes;
    if (!Number.isInteger(start) || !Number.isInteger(end)
      || start < -840 || start > 840 || end < -840 || end > 840 || start > end) {
      throw new Error(`${name}[${index}] is invalid`);
    }
    return { startMinutes: start, endMinutes: end };
  });
}

function validateDiscoveryPreferences(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  if (value.schemaVersion !== 1) throw new Error(`${name}.schemaVersion must be 1`);
  const title = value.title ?? {};
  if (!title || typeof title !== 'object' || Array.isArray(title)) {
    throw new Error(`${name}.title must be an object`);
  }
  const positive = stringArray(title.positive ?? [], `${name}.title.positive`, 300);
  const negative = stringArray(title.negative ?? [], `${name}.title.negative`, 300);
  const rawPatterns = title.positivePatterns ?? [];
  if (!Array.isArray(rawPatterns) || rawPatterns.length > 50) {
    throw new Error(`${name}.title.positivePatterns must contain at most 50 items`);
  }
  const positivePatterns = rawPatterns.map((pattern, index) => {
    const path = `${name}.title.positivePatterns[${index}]`;
    if (!pattern || typeof pattern !== 'object' || Array.isArray(pattern)) {
      throw new Error(`${path} must be an object`);
    }
    if (pattern.type !== 'orderedGap' || pattern.maxGapWords !== 2) {
      throw new Error(`${path} must be an orderedGap pattern with maxGapWords 2`);
    }
    return {
      type: 'orderedGap',
      left: patternTerms(pattern.left, `${path}.left`),
      right: patternTerms(pattern.right, `${path}.right`),
      maxGapWords: 2,
    };
  });

  let eligibility = null;
  if (value.eligibility != null) {
    if (typeof value.eligibility !== 'object' || Array.isArray(value.eligibility)) {
      throw new Error(`${name}.eligibility must be an object or null`);
    }
    eligibility = {};
    for (const [groupName, group] of Object.entries(value.eligibility)) {
      if (!['remote', 'hybrid', 'onSite', 'unknown'].includes(groupName)) {
        throw new Error(`${name}.eligibility contains unsupported group ${groupName}`);
      }
      if (!group || typeof group !== 'object' || Array.isArray(group)) {
        throw new Error(`${name}.eligibility.${groupName} must be an object`);
      }
      if (group.allowUnknownLocation != null && typeof group.allowUnknownLocation !== 'boolean') {
        throw new Error(`${name}.eligibility.${groupName}.allowUnknownLocation must be a boolean`);
      }
      eligibility[groupName] = {
        includeLocations: selectors(
          group.includeLocations ?? [],
          `${name}.eligibility.${groupName}.includeLocations`,
        ),
        excludeLocations: selectors(
          group.excludeLocations ?? [],
          `${name}.eligibility.${groupName}.excludeLocations`,
        ),
        // Validate these fields because they are part of the #8 contract. ATS
        // Discovery deliberately does not use them for candidate selection.
        utcOffsetRanges: ranges(
          group.utcOffsetRanges ?? [],
          `${name}.eligibility.${groupName}.utcOffsetRanges`,
        ),
        excludeWorkTimeRanges: ranges(
          group.excludeWorkTimeRanges ?? [],
          `${name}.eligibility.${groupName}.excludeWorkTimeRanges`,
        ),
        allowUnknownLocation: group.allowUnknownLocation ?? false,
      };
    }
  }
  return {
    schemaVersion: 1,
    title: { positive, positivePatterns, negative },
    eligibility,
  };
}

export function validateDiscoveryUsersPayload(payload, { maxUsers = 100 } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Users discovery response must be an object');
  }
  if (payload.schemaVersion !== 1) {
    throw new Error('Users discovery response schemaVersion must be 1');
  }
  if (!Array.isArray(payload.users)) {
    throw new Error('Users discovery response users must be an array');
  }
  if (payload.users.length > maxUsers) {
    throw new Error(`Users discovery response exceeds maxUsers ${maxUsers}`);
  }
  const seen = new Set();
  const users = payload.users.map((user, index) => {
    const name = `users[${index}]`;
    if (!user || typeof user !== 'object' || Array.isArray(user)) {
      throw new Error(`${name} must be an object`);
    }
    if (!uuidLike(user.userId)) throw new Error(`${name}.userId must be a GUID`);
    const key = user.userId.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate discovery user ${user.userId}`);
    seen.add(key);

    let discoveryPreferences = null;
    let discoveryPreferencesInvalid = user.discoveryPreferencesInvalid === true;
    let discoveryPreferencesError = null;
    if (user.discoveryPreferences != null && !discoveryPreferencesInvalid) {
      try {
        discoveryPreferences = validateDiscoveryPreferences(
          user.discoveryPreferences,
          `${name}.discoveryPreferences`,
        );
      } catch (error) {
        discoveryPreferencesInvalid = true;
        discoveryPreferencesError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      userId: user.userId,
      cvVersionId: boundedVersionId(user.cvVersionId, `${name}.cvVersionId`),
      cvLastUpdatedUtc: optionalTimestamp(user.cvLastUpdatedUtc, `${name}.cvLastUpdatedUtc`),
      discoveryPreferences,
      discoveryPreferencesInvalid,
      discoveryPreferencesError,
      discoveryPreferencesLastUpdatedUtc: optionalTimestamp(
        user.discoveryPreferencesLastUpdatedUtc,
        `${name}.discoveryPreferencesLastUpdatedUtc`,
      ),
    };
  });
  users.sort((left, right) => left.userId.localeCompare(right.userId));
  return {
    schemaVersion: 1,
    generatedAtUtc: optionalTimestamp(payload.generatedAtUtc, 'generatedAtUtc'),
    users,
    counts: payload.counts && typeof payload.counts === 'object' ? payload.counts : null,
  };
}

export function createUsersClient(config, { fetchImpl = fetch } = {}) {
  const endpoint = new URL(`${config.baseUrl}/users/internal/discovery-eligible`);
  endpoint.searchParams.set('limit', String(config.maxUsersPerRun));
  const headers = {
    accept: 'application/json',
    'x-functions-key': config.functionKey,
    'x-actor-type': 'system',
    'x-source-surface': 'system',
  };

  async function listDiscoveryEligible() {
    let lastError = null;
    for (let attempt = 0; attempt <= config.retryCount; attempt += 1) {
      let response = null;
      try {
        response = await fetchWithTimeout(fetchImpl, endpoint, { method: 'GET', headers }, config.timeoutMs);
        if (response.ok) {
          const payload = await response.json();
          return validateDiscoveryUsersPayload(payload, { maxUsers: config.maxUsersPerRun });
        }
        const body = await response.text().catch(() => '');
        const error = new Error(`Users API returned ${response.status}: ${body.slice(0, 500)}`);
        error.status = response.status;
        lastError = error;
        if (response.status !== 429 && response.status < 500) throw error;
      } catch (error) {
        lastError = error;
        if (response?.ok) throw error;
        if (error?.status && error.status !== 429 && error.status < 500) throw error;
        if (attempt === config.retryCount) throw error;
      }
      if (attempt === config.retryCount) break;
      await sleep(Math.min(500 * 2 ** attempt, 4000));
    }
    throw lastError ?? new Error('Users discovery request failed');
  }

  return { listDiscoveryEligible };
}
