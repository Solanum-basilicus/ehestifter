import { createHash } from 'node:crypto';

export const ASHBY_CATALOG_SOURCE = Object.freeze({
  repository: 'Feashliaa/job-board-aggregator',
  path: 'data/ashby_companies.json',
  url: 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/ashby_companies.json',
  license: 'CC BY-NC 4.0',
});

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function valuePreview(value) {
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

/**
 * Validate and normalize one Ashby board tenant.
 *
 * The tenant is used as one URL path segment:
 * https://jobs.ashbyhq.com/<tenant>
 */
export function validateAshbyTenant(
  value,
  {
    maxLength = 200,
  } = {},
) {
  if (typeof value !== 'string') {
    return {
      ok: false,
      reason: 'not_string',
      tenant: null,
    };
  }

  const tenant = value.trim();

  if (tenant === '') {
    return {
      ok: false,
      reason: 'empty',
      tenant: null,
    };
  }

  if (tenant.length > maxLength) {
    return {
      ok: false,
      reason: 'too_long',
      tenant: null,
    };
  }

  if (tenant === '.' || tenant === '..') {
    return {
      ok: false,
      reason: 'reserved_path_segment',
      tenant: null,
    };
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(tenant)) {
    return {
      ok: false,
      reason: 'url_scheme',
      tenant: null,
    };
  }

  if (/\s/.test(tenant)) {
    return {
      ok: false,
      reason: 'whitespace',
      tenant: null,
    };
  }

  if (
    tenant.includes('/')
    || tenant.includes('\\')
    || tenant.includes('?')
    || tenant.includes('#')
  ) {
    return {
      ok: false,
      reason: 'url_delimiter',
      tenant: null,
    };
  }

  /*
   * Deliberately narrower than every technically valid URL character.
   * Ashby company identifiers should be stable, readable board slugs.
   */
  if (!/^[A-Za-z0-9._~-]+$/.test(tenant)) {
    return {
      ok: false,
      reason: 'unsafe_character',
      tenant: null,
    };
  }

  return {
    ok: true,
    reason: null,
    tenant,
  };
}

/**
 * Convert exact downloaded bytes into the machine-managed catalog envelope.
 *
 * Individual malformed entries are rejected. A malformed document or a
 * document containing no usable tenants fails the whole refresh.
 */
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
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      'Ashby catalog root must be a JSON array',
    );
  }

  const fetchedAtDate = fetchedAt instanceof Date
    ? fetchedAt
    : new Date(fetchedAt);

  if (Number.isNaN(fetchedAtDate.getTime())) {
    throw new Error(
      'Ashby catalog fetchedAt must be a valid date',
    );
  }

  const tenants = [];
  const seen = new Set();
  const rejections = [];
  let duplicateItemCount = 0;

  for (
    let index = 0;
    index < parsed.length;
    index += 1
  ) {
    const value = parsed[index];
    const result = validateAshbyTenant(value);

    if (!result.ok) {
      rejections.push({
        index,
        reason: result.reason,
        valuePreview: valuePreview(value),
      });
      continue;
    }

    if (seen.has(result.tenant)) {
      duplicateItemCount += 1;
      continue;
    }

    seen.add(result.tenant);
    tenants.push(result.tenant);
  }

  if (tenants.length === 0) {
    throw new Error(
      'Ashby catalog contains no valid tenants',
    );
  }

  tenants.sort(compareStrings);

  return {
    schemaVersion: 1,
    provider: 'ashby',
    fetchedAtUtc: fetchedAtDate.toISOString(),
    source: {
      ...ASHBY_CATALOG_SOURCE,
      url: sourceUrl,
    },
    rawSha256: createHash('sha256')
      .update(bytes)
      .digest('hex'),
    sourceItemCount: parsed.length,
    acceptedItemCount: tenants.length,
    rejectedItemCount: rejections.length,
    duplicateItemCount,
    rejections,
    tenants,
  };
}
