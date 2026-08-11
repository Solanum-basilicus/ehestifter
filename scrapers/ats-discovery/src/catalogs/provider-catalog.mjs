import { createHash } from 'node:crypto';
import { parseStrictCsv } from './csv.mjs';
import { assertPublicHttpsUrl } from '../providers/_url-safety.mjs';

export const CATALOG_PROVIDER_IDS = Object.freeze([
  'ashby',
  'greenhouse',
  'lever',
  'workday',
  'personio',
  'smartrecruiters',
  'softgarden',
  'successfactors',
]);

export const CATALOG_SOURCES = Object.freeze({
  ashby: Object.freeze({
    repository: 'Feashliaa/job-board-aggregator',
    path: 'data/ashby_companies.json',
    url: 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/ashby_companies.json',
    ref: 'main',
    license: 'CC BY-NC 4.0',
    format: 'json',
  }),
  greenhouse: Object.freeze({
    repository: 'Feashliaa/job-board-aggregator',
    path: 'data/greenhouse_companies.json',
    url: 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/greenhouse_companies.json',
    ref: 'main',
    license: 'CC BY-NC 4.0',
    format: 'json',
  }),
  lever: Object.freeze({
    repository: 'Feashliaa/job-board-aggregator',
    path: 'data/lever_companies.json',
    url: 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/lever_companies.json',
    ref: 'main',
    license: 'CC BY-NC 4.0',
    format: 'json',
  }),
  workday: Object.freeze({
    repository: 'Feashliaa/job-board-aggregator',
    path: 'data/workday_companies.json',
    url: 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/workday_companies.json',
    ref: 'main',
    license: 'CC BY-NC 4.0',
    format: 'json',
  }),
  personio: Object.freeze({
    repository: 'kalil0321/ats-scrapers',
    path: 'ats-companies/personio.csv',
    url: 'https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies/personio.csv',
    ref: 'main',
    license: 'MIT',
    format: 'csv',
  }),
  smartrecruiters: Object.freeze({
    repository: 'kalil0321/ats-scrapers',
    path: 'ats-companies/smartrecruiters.csv',
    url: 'https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies/smartrecruiters.csv',
    ref: 'main',
    license: 'MIT',
    format: 'csv',
  }),
  softgarden: Object.freeze({
    repository: 'kalil0321/ats-scrapers',
    path: 'ats-companies/softgarden.csv',
    url: 'https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies/softgarden.csv',
    ref: 'main',
    license: 'MIT',
    format: 'csv',
  }),
  successfactors: Object.freeze({
    repository: 'kalil0321/ats-scrapers',
    path: 'ats-companies/successfactors.csv',
    url: 'https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies/successfactors.csv',
    ref: 'main',
    license: 'MIT',
    format: 'csv',
  }),
});

export const CATALOG_SOURCE_QUALITY = Object.freeze({
  personio: Object.freeze({ minimumSourceItems: 1000, minimumAcceptanceRatio: 0.98 }),
  smartrecruiters: Object.freeze({ minimumSourceItems: 1000, minimumAcceptanceRatio: 0.98 }),
  softgarden: Object.freeze({ minimumSourceItems: 100, minimumAcceptanceRatio: 0.98 }),
  // The upstream inventory currently contains legacy ?company= RMK URLs.
  // The current provider deliberately drops query parameters, so those rows
  // are rejected rather than collapsed into an unsafe hostname/path identity.
  successfactors: Object.freeze({ minimumSourceItems: 1000, minimumAcceptanceRatio: 0.85 }),
});

const MAX_COMPONENT_LENGTH = 200;
const MAX_OPTIONAL_NAME_LENGTH = 300;
const SAFE_SLUG = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const SAFE_HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const SAFE_SITE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const SAFE_SMARTRECRUITERS_TENANT = /^[A-Za-z0-9._-]+$/;

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
  if (provider === 'successfactors') {
    return { ok: false, reason: 'successfactors_requires_url_identity' };
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

function validateCatalogHostLabel(value, name = 'tenant') {
  const label = normalizeString(value);
  if (!label) return { ok: false, reason: `${name}_empty` };
  if (label.length > 63) return { ok: false, reason: `${name}_too_long` };
  if (!SAFE_HOST_LABEL.test(label)) return { ok: false, reason: `${name}_unsafe` };
  return { ok: true, value: label };
}

function validateSmartRecruitersTenant(value) {
  const tenant = normalizeString(value);
  if (!tenant) return { ok: false, reason: 'empty' };
  if (tenant.length > MAX_COMPONENT_LENGTH) return { ok: false, reason: 'too_long' };
  if (!SAFE_SMARTRECRUITERS_TENANT.test(tenant)) return { ok: false, reason: 'unsafe_character' };
  return { ok: true, tenant };
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
    sourceUrl: normalizeString(value.url),
    careersUrl: normalizeString(value.careersUrl),
  };
}

function parsePublicCatalogUrl(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, reason: 'url_missing' };
  }
  let parsed;
  try {
    parsed = assertPublicHttpsUrl(value.trim(), label);
  } catch {
    return { ok: false, reason: 'url_invalid' };
  }
  if (parsed.username || parsed.password) return { ok: false, reason: 'url_credentials' };
  if (parsed.port) return { ok: false, reason: 'url_port' };
  return { ok: true, parsed };
}

function withoutSearchOrHash(parsed) {
  const normalized = new URL(parsed);
  normalized.search = '';
  normalized.hash = '';
  return normalized;
}

function normalizePersonioItem(value) {
  const input = slugInput(value);
  if (!input) return { ok: false, reason: 'not_string_or_object' };
  const validated = validateCatalogHostLabel(input.tenant);
  if (!validated.ok) return validated;
  const expectedTenant = validated.value.toLowerCase();
  let careersUrl = `https://${expectedTenant}.jobs.personio.com`;
  const rawUrl = input.sourceUrl || input.careersUrl;
  if (rawUrl) {
    const result = parsePublicCatalogUrl(rawUrl, 'Personio catalog URL');
    if (!result.ok) return result;
    const parsed = result.parsed;
    const match = parsed.hostname.toLowerCase().match(/^([a-z0-9][a-z0-9-]*)\.jobs\.personio\.(de|com)$/);
    if (!match) return { ok: false, reason: 'personio_host' };
    if (match[1] !== expectedTenant) return { ok: false, reason: 'tenant_url_mismatch' };
    if (!['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) {
      return { ok: false, reason: 'personio_url_shape' };
    }
    careersUrl = `https://${parsed.hostname.toLowerCase()}`;
  }
  const item = { tenant: expectedTenant, careersUrl };
  if (input.name) item.name = input.name;
  return { ok: true, reason: null, item };
}

function normalizeSmartRecruitersItem(value) {
  const input = slugInput(value);
  if (!input) return { ok: false, reason: 'not_string_or_object' };
  const validated = validateSmartRecruitersTenant(input.tenant);
  if (!validated.ok) return validated;
  let tenant = validated.tenant;
  const rawUrl = input.sourceUrl || input.careersUrl;
  if (rawUrl) {
    const result = parsePublicCatalogUrl(rawUrl, 'SmartRecruiters catalog URL');
    if (!result.ok) return result;
    const parsed = result.parsed;
    if (!['careers.smartrecruiters.com', 'jobs.smartrecruiters.com'].includes(parsed.hostname.toLowerCase())) {
      return { ok: false, reason: 'smartrecruiters_host' };
    }
    if (parsed.search || parsed.hash) return { ok: false, reason: 'smartrecruiters_url_shape' };
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length === 0 || !SAFE_SMARTRECRUITERS_TENANT.test(segments[0])) {
      return { ok: false, reason: 'smartrecruiters_path' };
    }
    if (segments[0].toLowerCase() !== tenant.toLowerCase()) {
      return { ok: false, reason: 'tenant_url_mismatch' };
    }
    tenant = segments[0];
  }
  const item = {
    tenant,
    careersUrl: `https://careers.smartrecruiters.com/${tenant}`,
  };
  if (input.name) item.name = input.name;
  return { ok: true, reason: null, item };
}

function normalizeSoftgardenItem(value) {
  const input = slugInput(value);
  if (!input) return { ok: false, reason: 'not_string_or_object' };
  const validated = validateCatalogHostLabel(input.tenant);
  if (!validated.ok) return validated;
  const tenant = validated.value.toLowerCase();
  const rawUrl = input.sourceUrl || input.careersUrl;
  if (rawUrl) {
    const result = parsePublicCatalogUrl(rawUrl, 'Softgarden catalog URL');
    if (!result.ok) return result;
    const parsed = result.parsed;
    const hostname = parsed.hostname.toLowerCase();
    const sourceMatch = hostname.match(/^([a-z0-9][a-z0-9-]*)\.career\.softgarden\.de$/);
    const providerMatch = hostname.match(/^([a-z0-9][a-z0-9-]*)\.softgarden\.io$/);
    const urlTenant = sourceMatch?.[1] ?? providerMatch?.[1] ?? null;
    if (!urlTenant) return { ok: false, reason: 'softgarden_host' };
    if (urlTenant !== tenant) return { ok: false, reason: 'tenant_url_mismatch' };
    if (!['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) {
      return { ok: false, reason: 'softgarden_url_shape' };
    }
  }
  const item = { tenant, careersUrl: `https://${tenant}.softgarden.io/` };
  if (input.name) item.name = input.name;
  return { ok: true, reason: null, item };
}

function normalizeSuccessFactorsItem(value) {
  let rawUrl;
  let name = null;
  let explicitTenant = '';
  if (typeof value === 'string') {
    rawUrl = value;
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    rawUrl = value.url ?? value.careersUrl;
    name = normalizeOptionalName(value.name);
    explicitTenant = normalizeString(value.tenant);
  } else {
    return { ok: false, reason: 'not_string_or_object' };
  }
  const result = parsePublicCatalogUrl(rawUrl, 'SuccessFactors catalog URL');
  if (!result.ok) return result;
  const parsed = result.parsed;
  // The provider canonicalizer intentionally discards search/hash. Importing
  // query-qualified tenants would therefore merge distinct upstream companies.
  if (parsed.search || parsed.hash) return { ok: false, reason: 'query_identity_unsupported' };
  const normalized = withoutSearchOrHash(parsed);
  const path = normalized.pathname
    .replace(/\/(?:search|tile-search-results|services\/recruiting\/v1\/jobs)\/?$/i, '')
    .replace(/\/+$/, '');
  const tenant = `${normalized.hostname.toLowerCase()}${path}`;
  if (tenant.length > 600) return { ok: false, reason: 'tenant_too_long' };
  if (explicitTenant && explicitTenant !== tenant) {
    return { ok: false, reason: 'tenant_url_mismatch' };
  }
  const item = {
    tenant,
    careersUrl: `${normalized.origin}${path}`,
  };
  if (name) item.name = name;
  return { ok: true, reason: null, item };
}

export function normalizeCatalogItem(provider, value) {
  requireProvider(provider);
  if (provider === 'workday') return validateWorkdayCatalogItem(value);
  if (provider === 'personio') return normalizePersonioItem(value);
  if (provider === 'smartrecruiters') return normalizeSmartRecruitersItem(value);
  if (provider === 'softgarden') return normalizeSoftgardenItem(value);
  if (provider === 'successfactors') return normalizeSuccessFactorsItem(value);
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

function parseCatalogSource(provider, bytes) {
  const format = CATALOG_SOURCES[provider]?.format ?? 'json';
  if (format === 'json') {
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      throw new Error(`${provider} catalog is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!Array.isArray(parsed)) throw new Error(`${provider} catalog root must be a JSON array`);
    return parsed;
  }
  if (format === 'csv') {
    let records;
    try {
      records = parseStrictCsv(bytes.toString('utf8'), {
        expectedHeader: ['name', 'slug', 'url'],
        label: `${provider} catalog CSV`,
      });
    } catch (error) {
      throw new Error(`${provider} catalog is not valid CSV: ${error instanceof Error ? error.message : String(error)}`);
    }
    return records.slice(1).map(([name, slug, url], index) => {
      const row = { name, slug, url };
      Object.defineProperty(row, '_csvColumnCount', {
        value: records[index + 1].length,
        enumerable: false,
      });
      return row;
    });
  }
  throw new Error(`${provider} catalog source format is unsupported: ${format}`);
}

export function buildProviderCatalogEnvelope(provider, rawBytes, {
  fetchedAt = new Date(),
  sourceUrl = CATALOG_SOURCES[provider]?.url,
} = {}) {
  requireProvider(provider);
  const bytes = Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(String(rawBytes), 'utf8');
  const parsed = parseCatalogSource(provider, bytes);
  const date = fetchedAt instanceof Date ? fetchedAt : new Date(fetchedAt);
  if (Number.isNaN(date.getTime())) throw new Error(`${provider} catalog fetchedAt must be a valid date`);

  const items = [];
  const seen = new Set();
  const rejections = [];
  let duplicateItemCount = 0;
  for (let index = 0; index < parsed.length; index += 1) {
    if (parsed[index]?._csvColumnCount != null && parsed[index]._csvColumnCount !== 3) {
      rejections.push({ index, reason: 'csv_column_count', valuePreview: previewValue(parsed[index]) });
      continue;
    }
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

export function validateCatalogSourceQuality(provider, catalog, quality = CATALOG_SOURCE_QUALITY[provider]) {
  requireProvider(provider);
  if (quality == null || quality === false) return catalog;
  const minimumSourceItems = quality.minimumSourceItems;
  const minimumAcceptanceRatio = quality.minimumAcceptanceRatio;
  if (!Number.isInteger(minimumSourceItems) || minimumSourceItems <= 0) {
    throw new Error(`${provider} catalog quality minimumSourceItems must be a positive integer`);
  }
  if (
    typeof minimumAcceptanceRatio !== 'number'
    || !Number.isFinite(minimumAcceptanceRatio)
    || minimumAcceptanceRatio <= 0
    || minimumAcceptanceRatio > 1
  ) {
    throw new Error(`${provider} catalog quality minimumAcceptanceRatio must be in (0, 1]`);
  }
  if (catalog.sourceItemCount < minimumSourceItems) {
    throw new Error(
      `${provider} catalog source quality check failed: ${catalog.sourceItemCount} rows `
      + `is below minimum ${minimumSourceItems}`,
    );
  }
  const acceptanceRatio = catalog.sourceItemCount === 0
    ? 0
    : catalog.acceptedItemCount / catalog.sourceItemCount;
  if (acceptanceRatio < minimumAcceptanceRatio) {
    throw new Error(
      `${provider} catalog source quality check failed: acceptance ratio `
      + `${acceptanceRatio.toFixed(4)} is below minimum ${minimumAcceptanceRatio.toFixed(4)}`,
    );
  }
  return catalog;
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
