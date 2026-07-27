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
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string`);
  }
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
  if (Number.isNaN(parsed)) {
    throw new Error(`${name} must be a valid timestamp`);
  }
  return new Date(parsed).toISOString();
}

function optionalBoundedId(value, name) {
  if (value == null) return null;
  if (
    typeof value !== 'string'
    || value.trim() === ''
    || value.length > 128
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${name} must be a bounded identifier or null`);
  }
  return value.trim();
}

function boundedStrings(value, name, { maxItems = 50, maxLength = 120 } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  if (value.length > maxItems) throw new Error(`${name} exceeds ${maxItems} items`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '' || item.length > maxLength) {
      throw new Error(`${name}[${index}] must be a nonempty bounded string`);
    }
    return item.trim();
  });
}

function validateProfile(profile, name) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error(`${name} must be an object`);
  }
  const title = profile.title ?? {};
  const location = profile.location ?? {};
  const company = profile.company ?? {};
  const normalized = {
    profileId: optionalBoundedId(profile.profileId, `${name}.profileId`),
    title: {
      positive: boundedStrings(title.positive, `${name}.title.positive`),
      negative: boundedStrings(title.negative, `${name}.title.negative`),
    },
    location: {
      alwaysAllow: boundedStrings(
        location.alwaysAllow,
        `${name}.location.alwaysAllow`,
      ),
      allow: boundedStrings(location.allow, `${name}.location.allow`),
      block: boundedStrings(location.block, `${name}.location.block`),
    },
    company: {
      allow: boundedStrings(company.allow, `${name}.company.allow`),
      block: boundedStrings(company.block, `${name}.company.block`),
    },
    remoteTypes: boundedStrings(profile.remoteTypes, `${name}.remoteTypes`, {
      maxItems: 10,
      maxLength: 40,
    }),
  };
  const hasConstraint = [
    ...normalized.title.positive,
    ...normalized.title.negative,
    ...normalized.location.alwaysAllow,
    ...normalized.location.allow,
    ...normalized.location.block,
    ...normalized.company.allow,
    ...normalized.company.block,
    ...normalized.remoteTypes,
  ].length > 0;
  if (!hasConstraint) {
    throw new Error(`${name} must contain at least one discovery constraint`);
  }
  return normalized;
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
    const cvVersionId = boundedVersionId(
      user.cvVersionId,
      `${name}.cvVersionId`,
    );
    const key = user.userId.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate discovery user ${user.userId}`);
    seen.add(key);
    if (!Array.isArray(user.profiles)) {
      throw new Error(`${name}.profiles must be an array`);
    }
    if (user.profiles.length > 20) {
      throw new Error(`${name}.profiles exceeds 20 items`);
    }
    if (typeof user.hasSavedFilters !== 'boolean') {
      throw new Error(`${name}.hasSavedFilters must be a boolean`);
    }
    if (
      !Number.isInteger(user.invalidProfileCount)
      || user.invalidProfileCount < 0
      || user.invalidProfileCount > 20
    ) {
      throw new Error(`${name}.invalidProfileCount must be between 0 and 20`);
    }
    return {
      userId: user.userId,
      cvVersionId,
      cvLastUpdatedUtc: optionalTimestamp(
        user.cvLastUpdatedUtc,
        `${name}.cvLastUpdatedUtc`,
      ),
      hasSavedFilters: user.hasSavedFilters,
      invalidProfileCount: user.invalidProfileCount,
      profiles: user.profiles.map(
        (profile, profileIndex) => validateProfile(
          profile,
          `${name}.profiles[${profileIndex}]`,
        ),
      ),
    };
  });
  users.sort((left, right) => left.userId.localeCompare(right.userId));
  return {
    schemaVersion: 1,
    generatedAtUtc: optionalTimestamp(
      payload.generatedAtUtc,
      'generatedAtUtc',
    ),
    users,
    counts: payload.counts && typeof payload.counts === 'object'
      ? payload.counts
      : null,
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
        response = await fetchWithTimeout(
          fetchImpl,
          endpoint,
          { method: 'GET', headers },
          config.timeoutMs,
        );
        if (response.ok) {
          const payload = await response.json();
          return validateDiscoveryUsersPayload(payload, {
            maxUsers: config.maxUsersPerRun,
          });
        }
        const body = await response.text().catch(() => '');
        const error = new Error(
          `Users API returned ${response.status}: ${body.slice(0, 500)}`,
        );
        error.status = response.status;
        lastError = error;
        if (response.status !== 429 && response.status < 500) throw error;
      } catch (error) {
        lastError = error;
        if (response?.ok) throw error;
        if (
          error?.status
          && error.status !== 429
          && error.status < 500
        ) throw error;
        if (attempt === config.retryCount) throw error;
      }
      if (attempt === config.retryCount) break;
      await sleep(Math.min(500 * 2 ** attempt, 4000));
    }
    throw lastError ?? new Error('Users discovery request failed');
  }

  return { listDiscoveryEligible };
}
