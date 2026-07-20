import { createHash } from 'node:crypto';

export const ASHBY_CATALOG_SOURCE = Object.freeze({
  repository: 'Feashliaa/job-board-aggregator',
  path: 'data/ashby_companies.json',
  url: 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/ashby_companies.json',
  license: 'CC BY-NC 4.0',
});

const MAX_TENANT_LENGTH = 200;
const SAFE_TENANT = /^[A-Za-z0-9._~-]+$/;

function stringCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function previewValue(value) {
  let rendered;
  try {
    rendered = JSON.stringify(value);
  } catch {
    rendered = String(value);
  }
  return rendered.length <= 120
    ? rendered
    : `${rendered.slice(0, 117)}...`;
}

function tenantKey(tenant) {
  return tenant.toLowerCase();
}

export function validateAshbyTenant(
  value,
  { maxLength = MAX_TENANT_LENGTH } = {},
) {
  if (typeof value !== 'string') {
    return { ok: false, reason: 'not_string', tenant: null };
  }

  const tenant = value.trim();
  if (tenant === '') {
    return { ok: false, reason: 'empty', tenant: null };
  }
  if (tenant.length > maxLength) {
    return { ok: false, reason: 'too_long', tenant: null };
  }
  if (tenant === '.' || tenant === '..') {
    return {
      ok: false,
      reason: 'reserved_path_segment',
      tenant: null,
    };
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(tenant)) {
    return { ok: false, reason: 'url_scheme', tenant: null };
  }
  if (/\s/.test(tenant)) {
    return { ok: false, reason: 'whitespace', tenant: null };
  }
  if (
    tenant.includes('/')
    || tenant.includes('\\')
    || tenant.includes('?')
    || tenant.includes('#')
  ) {
    return { ok: false, reason: 'url_delimiter', tenant: null };
  }
  if (!SAFE_TENANT.test(tenant)) {
    return { ok: false, reason: 'unsafe_character', tenant: null };
  }

  return { ok: true, reason: null, tenant };
}

export function buildAshbyCatalogEnvelope(
  rawBytes,
  {
    fetchedAt = new Date(),
    sourceUrl = ASHBY_CATALOG_SOURCE.url,
  } = {},
) {
  const bytes = Buffer.isBuffer(rawBytes)
    ? rawBytes
    : Buffer.from(String(rawBytes), 'utf8');

  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(
      `Ashby catalog is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Ashby catalog root must be a JSON array');
  }

  const fetchedAtDate = fetchedAt instanceof Date
    ? fetchedAt
    : new Date(fetchedAt);
  if (Number.isNaN(fetchedAtDate.getTime())) {
    throw new Error('Ashby catalog fetchedAt must be a valid date');
  }

  const tenants = [];
  const seen = new Set();
  const rejections = [];
  let duplicateItemCount = 0;

  for (let index = 0; index < parsed.length; index += 1) {
    const value = parsed[index];
    const result = validateAshbyTenant(value);

    if (!result.ok) {
      rejections.push({
        index,
        reason: result.reason,
        valuePreview: previewValue(value),
      });
      continue;
    }

    const key = tenantKey(result.tenant);
    if (seen.has(key)) {
      duplicateItemCount += 1;
      continue;
    }

    seen.add(key);
    tenants.push(result.tenant);
  }

  if (tenants.length === 0) {
    throw new Error('Ashby catalog contains no valid tenants');
  }

  tenants.sort((left, right) => {
    const keyOrder = stringCompare(tenantKey(left), tenantKey(right));
    return keyOrder || stringCompare(left, right);
  });

  return {
    schemaVersion: 1,
    provider: 'ashby',
    fetchedAtUtc: fetchedAtDate.toISOString(),
    source: {
      ...ASHBY_CATALOG_SOURCE,
      url: sourceUrl,
    },
    rawSha256: createHash('sha256').update(bytes).digest('hex'),
    sourceItemCount: parsed.length,
    acceptedItemCount: tenants.length,
    rejectedItemCount: rejections.length,
    duplicateItemCount,
    rejections,
    tenants,
  };
}

/**
 * Validate a persisted machine-managed catalog before it affects scan scope.
 * This prevents a hand-edited or truncated catalog from silently broadening or
 * changing the target plan.
 */
export function validateAshbyCatalogEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Ashby catalog envelope must be a JSON object');
  }
  if (value.schemaVersion !== 1) {
    throw new Error('Ashby catalog schemaVersion must be 1');
  }
  if (value.provider !== 'ashby') {
    throw new Error('Ashby catalog provider must be "ashby"');
  }
  if (
    typeof value.rawSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.rawSha256)
  ) {
    throw new Error('Ashby catalog rawSha256 must be a lowercase SHA-256');
  }
  if (
    typeof value.fetchedAtUtc !== 'string'
    || Number.isNaN(Date.parse(value.fetchedAtUtc))
  ) {
    throw new Error('Ashby catalog fetchedAtUtc must be an ISO date');
  }
  if (!Array.isArray(value.tenants) || value.tenants.length === 0) {
    throw new Error('Ashby catalog tenants must be a non-empty array');
  }

  const seen = new Set();
  for (const tenantValue of value.tenants) {
    const result = validateAshbyTenant(tenantValue);
    if (!result.ok) {
      throw new Error(
        `Ashby catalog contains invalid tenant (${result.reason})`,
      );
    }
    const key = tenantKey(result.tenant);
    if (seen.has(key)) {
      throw new Error('Ashby catalog contains duplicate tenants');
    }
    seen.add(key);
  }

  if (value.acceptedItemCount !== value.tenants.length) {
    throw new Error(
      'Ashby catalog acceptedItemCount does not match tenants length',
    );
  }

  for (const [field, expected] of Object.entries({
    repository: ASHBY_CATALOG_SOURCE.repository,
    path: ASHBY_CATALOG_SOURCE.path,
    license: ASHBY_CATALOG_SOURCE.license,
  })) {
    if (value.source?.[field] !== expected) {
      throw new Error(`Ashby catalog source.${field} is invalid`);
    }
  }
  if (typeof value.source?.url !== 'string' || value.source.url.trim() === '') {
    throw new Error('Ashby catalog source.url must be a non-empty string');
  }

  for (const field of [
    'sourceItemCount',
    'acceptedItemCount',
    'rejectedItemCount',
    'duplicateItemCount',
  ]) {
    if (!Number.isInteger(value[field]) || value[field] < 0) {
      throw new Error(`Ashby catalog ${field} must be a non-negative integer`);
    }
  }
  if (!Array.isArray(value.rejections)) {
    throw new Error('Ashby catalog rejections must be an array');
  }
  if (value.rejections.length !== value.rejectedItemCount) {
    throw new Error(
      'Ashby catalog rejectedItemCount does not match rejections length',
    );
  }
  if (
    value.sourceItemCount
    !== value.acceptedItemCount
      + value.rejectedItemCount
      + value.duplicateItemCount
  ) {
    throw new Error('Ashby catalog item counts are inconsistent');
  }

  return value;
}
