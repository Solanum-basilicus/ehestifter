import {
  CATALOG_SOURCES,
  buildProviderCatalogEnvelope,
  validateCatalogSlug,
  validateProviderCatalogEnvelope,
} from './provider-catalog.mjs';

export const ASHBY_CATALOG_SOURCE = CATALOG_SOURCES.ashby;

export function validateAshbyTenant(value, options = {}) {
  const result = validateCatalogSlug('ashby', value);
  if (!result.ok) return { ok: false, reason: result.reason, tenant: null };
  if (options.maxLength != null && result.tenant.length > options.maxLength) {
    return { ok: false, reason: 'too_long', tenant: null };
  }
  return result;
}

export function buildAshbyCatalogEnvelope(rawBytes, options = {}) {
  const envelope = buildProviderCatalogEnvelope('ashby', rawBytes, options);
  return {
    ...envelope,
    tenants: envelope.items.map((item) => item.tenant),
  };
}

export function validateAshbyCatalogEnvelope(value) {
  const validated = validateProviderCatalogEnvelope('ashby', value);
  return {
    ...validated,
    tenants: validated.items.map((item) => item.tenant),
  };
}
