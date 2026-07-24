import { createHash } from 'node:crypto';

export const CATALOG_PROVIDER_IDS = Object.freeze([
  'ashby',
  'greenhouse',
  'lever',
  'workday',
]);

export const CATALOG_SOURCES = Object.freeze({
  ashby: Object.freeze({
    repository: 'Feashliaa/job-board-aggregator',
    path: 'data/ashby_companies.json',
    url: 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/ashby_companies.json',
    ref: 'main',
    license: 'CC BY-NC 4.0',
  }),
  greenhouse: Object.freeze({
    repository: 'Feashliaa/job-board-aggregator',
    path: 'data/greenhouse_companies.json',
    url: 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/greenhouse_companies.json',
    ref: 'main',
    license: 'CC BY-NC 4.0',
  }),
  lever: Object.freeze({
    repository: 'Feashliaa/job-board-aggregator',
    path: 'data/lever_companies.json',
    url: 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/lever_companies.json',
    ref: 'main',
    license: 'CC BY-NC 4.0',
  }),
  workday: Object.freeze({
    repository: 'Feashliaa/job-board-aggregator',
    path: 'data/workday_companies.json',
    url: 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/workday_companies.json',
    ref: 'main',
    license: 'CC BY-NC 4.0',
  }),
});

const MAX_COMPONENT_LENGTH = 200;
const MAX_OPTIONAL_NAME_LENGTH = 300;
const SAFE_SLUG = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const SAFE_HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const SAFE_SITE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

function requireProvider(provider) {
  if (!CATALOG_PROVIDER_IDS.includes(provider)) {
    throw new Error(`Unsupported catalog provider: ${provider}`);
  }
  return provider;
}

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
  return rendered.length <= 160 ? rendered : `${rendered.slice(0, 157)}...`;
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOptionalName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > MAX_OPTIONAL_NAME_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

function validateSlug(value, { name = 'tenant', maxLength = MAX_COMPONENT_LENGTH } = {}) {
  if (typeof value !== 'string') return { ok: false, reason: 'not_string' };
  const slug = value.trim();
  if (!slug) return { ok: false, reason: 'empty' };
  if (slug.length > maxLength) return { ok: false, reason: 'too_long' };
  if (slug === '.' || slug === '..') return { ok: false, reason: 'reserved_path_segment' };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(slug)) return { ok: false, reason: 'url_scheme' };
  if (/\s/.test(slug)) return { ok: false, reason: 'whitespace' };
  if (/[\\/?#|]/.test(slug)) return { ok: false, reason: 'url_delimiter' };
  if (!SAFE_SLUG.test(slug)) return { ok: false, reason: 'unsafe_character' };
  return { ok: true, reason: null, [name]: slug };
}

export function validateCatalogSlug(provider, value) {
  requireProvider(provider);
  if (provider === 'workday') {
    return { ok: false, reason: 'workday_requires_structured_identity' };
  }
  return validateSlug(value, { name: 'tenant' });
}

function validateWorkdayHostLabel(value, name) {
  const label = normalizeString(value);
  if (!label) return { ok: false, reason: `${name}_empty` };
  if (label.length > 63) return { ok: false, reason: `${name}_too_long` };
  if (!SAFE_HOST_LABEL.test(label)) return { ok: false, reason: `${name}_unsafe` };
  return { ok: true, value: label };
}

function validateWorkdaySite(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'site_not_string' };
  const site = value.trim().replace(/^\/+|\/+$/g, '');
  if (!site) return { ok: false, reason: 'site_empty' };
  if (site.length > 400) return { ok: false, reason: 'site_too_long' };
  const segments = site.split('/');
  if (segments.length > 8) return { ok: false, reason: 'site_too_deep' };
  if (segments.some((segment) => !SAFE_SITE_SEGMENT.test(segment))) {
    return { ok: false, reason: 'site_unsafe' };
  }
  return { ok: true, value: segments.join('/') };
}

function parseWorkdayValue(value) {
  if (typeof value === 'string') {
    const parts = value.split('|');
    if (parts.length !== 3) return { ok: false, reason: 'workday_triple_required' };
    return { ok: true, tenant: parts[0], instance: parts[1], site: parts[2] };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'not_string_or_object' };
  }
  if (typeof value.slug === 'string' && value.slug.includes('|')) {
    const parsed = parseWorkdayValue(value.slug);
    if (!parsed.ok) return parsed;
    const explicitTenant = normalizeString(value.tenant);
    const explicitInstance = normalizeString(value.instance);
    const explicitSite = normalizeString(value.site).replace(/^\/+|\/+$/g, '');
    if (explicitTenant && explicitTenant.toLowerCase() !== parsed.tenant.trim().toLowerCase()) {
      return { ok: false, reason: 'tenant_mismatch' };
    }
    if (explicitInstance && explicitInstance.toLowerCase() !== parsed.instance.trim().toLowerCase()) {
      return { ok: false, reason: 'instance_mismatch' };
    }
    if (explicitSite && explicitSite !== parsed.site.trim().replace(/^\/+|\/+$/g, '')) {
      return { ok: false, reason: 'site_mismatch' };
    }
    return {
      ...parsed,
      name: normalizeOptionalName(value.name),
      host: normalizeString(value.host) || null,
    };
  }
  const host = normalizeString(value.host);
  const tenant = normalizeString(value.tenant);
  const site = normalizeString(value.site);
  let instance = normalizeString(value.instance);
  if (!instance && host) {
    const match = host.toLowerCase().match(/^([a-z0-9-]+)\.([a-z0-9-]+)\.myworkdayjobs\.com$/);
    if (match && (!tenant || match[1] === tenant.toLowerCase())) instance = match[2];
  }
  return {
    ok: true,
    tenant,
    instance,
    site,
    name: normalizeOptionalName(value.name),
    host: host || null,
  };
}

export function validateWorkdayCatalogItem(value) {
  const parsed = parseWorkdayValue(value);
  if (!parsed.ok) return parsed;
  const tenant = validateWorkdayHostLabel(parsed.tenant, 'tenant');
  if (!tenant.ok) return tenant;
  const instance = validateWorkdayHostLabel(parsed.instance, 'instance');
  if (!instance.ok) return instance;
  const site = validateWorkdaySite(parsed.site);
  if (!site.ok) return site;

  const host = `${tenant.value}.${instance.value}.myworkdayjobs.com`.toLowerCase();
  if (parsed.host && parsed.host.toLowerCase() !== host) {
    return { ok: false, reason: 'host_mismatch' };
  }
  const normalized = {
    tenant: tenant.value,
    instance: instance.value,
    site: site.value,
    host,
    careersUrl: `https://${host}/${site.value}`,
  };
  if (parsed.name) normalized.name = parsed.name;
  return { ok: true, reason: null, item: normalized };
}

function slugInput(value) {
  if (typeof value === 'string') return { tenant: value, name: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    tenant: value.slug ?? value.tenant,
    name: normalizeOptionalName(value.name),
  };
}

export function normalizeCatalogItem(provider, value) {
  requireProvider(provider);
  if (provider === 'workday') return validateWorkdayCatalogItem(value);
  const input = slugInput(value);
  if (!input) return { ok: false, reason: 'not_string_or_object' };
  const validated = validateCatalogSlug(provider, input.tenant);
  if (!validated.ok) return validated;
  const baseUrls = {
    ashby: 'https://jobs.ashbyhq.com',
    greenhouse: 'https://job-boards.greenhouse.io',
    lever: 'https://jobs.lever.co',
  };
  const item = {
    tenant: validated.tenant,
    careersUrl: `${baseUrls[provider]}/${validated.tenant}`,
  };
  if (input.name) item.name = input.name;
  return { ok: true, reason: null, item };
}

export function catalogItemKey(provider, item) {
  requireProvider(provider);
  if (provider === 'workday') {
    return `${item.tenant}|${item.instance}|${item.site}`.toLowerCase();
  }
  return item.tenant.toLowerCase();
}

export function catalogItemToPortalEntry(provider, item) {
  const normalized = normalizeCatalogItem(provider, item);
  if (!normalized.ok) {
    throw new Error(`${provider} catalog item is invalid (${normalized.reason})`);
  }
  const entry = normalized.item;
  return {
    name: entry.name ?? entry.tenant,
    careers_url: entry.careersUrl,
    provider,
    provider_tenant: provider === 'workday'
      ? `${entry.host}/${entry.site}`
      : entry.tenant,
    ...(provider === 'workday' ? {
      workday_tenant: entry.tenant,
      workday_instance: entry.instance,
      workday_site: entry.site,
    } : {}),
  };
}

export function buildProviderCatalogEnvelope(provider, rawBytes, {
  fetchedAt = new Date(),
  sourceUrl = CATALOG_SOURCES[provider]?.url,
} = {}) {
  requireProvider(provider);
  const bytes = Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(String(rawBytes), 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${provider} catalog is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${provider} catalog root must be a JSON array`);
  const date = fetchedAt instanceof Date ? fetchedAt : new Date(fetchedAt);
  if (Number.isNaN(date.getTime())) throw new Error(`${provider} catalog fetchedAt must be a valid date`);

  const items = [];
  const seen = new Set();
  const rejections = [];
  let duplicateItemCount = 0;
  for (let index = 0; index < parsed.length; index += 1) {
    const result = normalizeCatalogItem(provider, parsed[index]);
    if (!result.ok) {
      rejections.push({ index, reason: result.reason, valuePreview: previewValue(parsed[index]) });
      continue;
    }
    const key = catalogItemKey(provider, result.item);
    if (seen.has(key)) {
      duplicateItemCount += 1;
      continue;
    }
    seen.add(key);
    items.push(result.item);
  }
  if (items.length === 0) throw new Error(`${provider} catalog contains no valid items`);
  items.sort((left, right) => {
    const leftKey = catalogItemKey(provider, left);
    const rightKey = catalogItemKey(provider, right);
    return stringCompare(leftKey, rightKey) || stringCompare(JSON.stringify(left), JSON.stringify(right));
  });
  return {
    schemaVersion: 2,
    provider,
    fetchedAtUtc: date.toISOString(),
    source: { ...CATALOG_SOURCES[provider], url: sourceUrl },
    rawSha256: createHash('sha256').update(bytes).digest('hex'),
    sourceItemCount: parsed.length,
    acceptedItemCount: items.length,
    rejectedItemCount: rejections.length,
    duplicateItemCount,
    rejections,
    items,
  };
}

function legacyAshbyToV2(value) {
  if (value?.schemaVersion !== 1 || value?.provider !== 'ashby' || !Array.isArray(value.tenants)) return value;
  return {
    ...value,
    schemaVersion: 2,
    source: { ...value.source, ref: value.source?.ref ?? 'main' },
    items: value.tenants.map((tenant) => ({
      tenant,
      careersUrl: `https://jobs.ashbyhq.com/${tenant}`,
    })),
  };
}

export function validateProviderCatalogEnvelope(provider, rawValue) {
  requireProvider(provider);
  const value = provider === 'ashby' ? legacyAshbyToV2(rawValue) : rawValue;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${provider} catalog envelope must be a JSON object`);
  }
  if (value.schemaVersion !== 2) throw new Error(`${provider} catalog schemaVersion must be 2`);
  if (value.provider !== provider) throw new Error(`${provider} catalog provider is invalid`);
  if (typeof value.rawSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.rawSha256)) {
    throw new Error(`${provider} catalog rawSha256 must be a lowercase SHA-256`);
  }
  if (typeof value.fetchedAtUtc !== 'string' || Number.isNaN(Date.parse(value.fetchedAtUtc))) {
    throw new Error(`${provider} catalog fetchedAtUtc must be an ISO date`);
  }
  if (!Array.isArray(value.items) || value.items.length === 0) {
    throw new Error(`${provider} catalog items must be a non-empty array`);
  }
  const seen = new Set();
  for (const item of value.items) {
    const result = normalizeCatalogItem(provider, item);
    if (!result.ok) throw new Error(`${provider} catalog contains invalid item (${result.reason})`);
    const key = catalogItemKey(provider, result.item);
    if (seen.has(key)) throw new Error(`${provider} catalog contains duplicate items`);
    seen.add(key);
  }
  if (value.acceptedItemCount !== value.items.length) {
    throw new Error(`${provider} catalog acceptedItemCount does not match items length`);
  }
  const expectedSource = CATALOG_SOURCES[provider];
  for (const field of ['repository', 'path', 'license']) {
    if (value.source?.[field] !== expectedSource[field]) {
      throw new Error(`${provider} catalog source.${field} is invalid`);
    }
  }
  if (typeof value.source?.url !== 'string' || !value.source.url.trim()) {
    throw new Error(`${provider} catalog source.url must be non-empty`);
  }
  let sourceUrl;
  try {
    sourceUrl = new URL(value.source.url);
  } catch {
    throw new Error(`${provider} catalog source.url must be a valid URL`);
  }
  if (sourceUrl.protocol !== 'https:') {
    throw new Error(`${provider} catalog source.url must use HTTPS`);
  }
  if (typeof value.source?.ref !== 'string' || !value.source.ref.trim()) {
    throw new Error(`${provider} catalog source.ref must be non-empty`);
  }
  for (const field of ['sourceItemCount', 'acceptedItemCount', 'rejectedItemCount', 'duplicateItemCount']) {
    if (!Number.isInteger(value[field]) || value[field] < 0) {
      throw new Error(`${provider} catalog ${field} must be a non-negative integer`);
    }
  }
  if (!Array.isArray(value.rejections) || value.rejections.length !== value.rejectedItemCount) {
    throw new Error(`${provider} catalog rejection counts are inconsistent`);
  }
  if (value.sourceItemCount !== value.acceptedItemCount + value.rejectedItemCount + value.duplicateItemCount) {
    throw new Error(`${provider} catalog item counts are inconsistent`);
  }
  return value;
}
