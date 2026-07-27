const SUCCESSFACTORS_CSB_HOSTS = Object.freeze([
  /(?:^|\.)jobs\.hr\.cloud\.sap$/i,
  /(?:^|\.)jobs\.hr\.sapcloud\.cn$/i,
]);

function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

export function successFactorsVariant(entry) {
  const explicit = clean(entry?.sf_variant ?? entry?.sfVariant ?? entry?.providerVariant);
  if (explicit === 'csb' || explicit === 'rmk') return explicit;
  if (explicit != null) {
    throw new Error(`Unsupported SuccessFactors variant: ${explicit}`);
  }

  const raw = entry?.api || entry?.careers_url || '';
  try {
    const host = new URL(raw).hostname;
    if (SUCCESSFACTORS_CSB_HOSTS.some((pattern) => pattern.test(host))) return 'csb';
  } catch {
    /* Invalid URLs are handled by provider-specific validation. */
  }
  return 'rmk';
}

export function providerVariant(provider, target = null) {
  const providerId = clean(provider);
  if (!providerId) return null;
  if (providerId === 'successfactors') return successFactorsVariant(target);
  return null;
}

export function providerHealthPartition(provider, variant = null) {
  const providerId = clean(provider);
  if (!providerId) throw new Error('provider is required for health partition');
  const normalizedVariant = clean(variant);
  return normalizedVariant ? `${providerId}:${normalizedVariant}` : providerId;
}

export function targetHealthIdentity(target) {
  const provider = clean(target?.provider);
  if (!provider) throw new Error('target.provider is required');
  const variant = providerVariant(provider, target);
  return {
    provider,
    providerVariant: variant,
    healthPartition: providerHealthPartition(provider, variant),
  };
}
