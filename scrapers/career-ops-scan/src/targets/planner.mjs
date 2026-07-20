import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';

import {
  validateAshbyCatalogEnvelope,
  validateAshbyTenant,
} from '../catalogs/ashby-catalog.mjs';
import { resolveProvider } from '../providers/_registry.mjs';

export const PHASE2_MAX_NORMAL_ASHBY_TARGETS = 100;

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function requireSchemaVersion(value, name) {
  const object = requireObject(value, name);
  if (object.schema_version !== 1) {
    throw new Error(`${name}.schema_version must be 1`);
  }
  return object;
}

function parseYaml(text, name) {
  let parsed;
  try {
    parsed = yaml.load(text) ?? {};
  } catch (error) {
    throw new Error(`${name} is not valid YAML`, { cause: error });
  }
  return requireObject(parsed, name);
}

function normalizeMode(mode) {
  if (!['offline', 'preflight', 'import'].includes(mode)) {
    throw new Error(`Unsupported scan mode: ${mode}`);
  }
  return mode;
}

function normalizeOverrideTenants(value, name) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }

  const tenants = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const result = validateAshbyTenant(value[index]);
    if (!result.ok) {
      throw new Error(
        `${name}[${index}] is invalid (${result.reason})`,
      );
    }
    const key = result.tenant.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      tenants.push(result.tenant);
    }
  }
  return tenants;
}

function readAshbyPolicy(discoveryPolicy) {
  const policy = requireSchemaVersion(
    discoveryPolicy,
    'discovery policy',
  );
  const providers = requireObject(
    policy.providers,
    'discovery policy.providers',
  );
  const ashby = requireObject(
    providers.ashby,
    'discovery policy.providers.ashby',
  );

  const catalogEnabled = ashby.catalog_enabled ?? true;
  if (typeof catalogEnabled !== 'boolean') {
    throw new Error(
      'discovery policy.providers.ashby.catalog_enabled must be boolean',
    );
  }

  const maxNormalTargets = ashby.max_normal_targets_per_run ?? 100;
  if (
    !Number.isInteger(maxNormalTargets)
    || maxNormalTargets <= 0
    || maxNormalTargets > PHASE2_MAX_NORMAL_ASHBY_TARGETS
  ) {
    throw new Error(
      'discovery policy.providers.ashby.max_normal_targets_per_run '
      + `must be an integer from 1 to ${PHASE2_MAX_NORMAL_ASHBY_TARGETS}`,
    );
  }

  return { catalogEnabled, maxNormalTargets };
}

function readOverrides(companyOverrides) {
  const overrides = requireSchemaVersion(
    companyOverrides,
    'company overrides',
  );
  const priority = requireObject(
    overrides.priority ?? {},
    'company overrides.priority',
  );
  const disabled = requireObject(
    overrides.disabled ?? {},
    'company overrides.disabled',
  );

  return {
    priorityAshby: normalizeOverrideTenants(
      priority.ashby,
      'company overrides.priority.ashby',
    ),
    disabledAshby: normalizeOverrideTenants(
      disabled.ashby,
      'company overrides.disabled.ashby',
    ),
  };
}

function parseCareersUrl(value, companyName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Tracked company ${companyName} has no careers_url`);
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch (error) {
    throw new Error(
      `Tracked company ${companyName} has an invalid careers_url`,
      { cause: error },
    );
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(
      `Tracked company ${companyName} careers_url must use HTTP(S)`,
    );
  }
  return parsed;
}

function deriveTrackedTenant(entry, providerId) {
  if (
    typeof entry.provider_tenant === 'string'
    && entry.provider_tenant.trim()
  ) {
    return entry.provider_tenant.trim();
  }

  const parsed = parseCareersUrl(entry.careers_url, entry.name);
  const segments = parsed.pathname.split('/').filter(Boolean);

  if (['greenhouse', 'lever', 'ashby'].includes(providerId)) {
    if (!segments[0]) {
      throw new Error(
        `Tracked company ${entry.name} URL has no provider tenant`,
      );
    }
    return segments[0];
  }

  // Workday tenant identity is provider-specific and can span host/site path.
  // Keeping the complete normalized host/path is safer than guessing one token.
  if (providerId === 'workday') {
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/$/, '')}`;
  }

  return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/$/, '')}`;
}

function targetKey(provider, tenant) {
  return `${provider}\0${tenant.toLowerCase()}`;
}

function hashCatalogTenant(tenant) {
  return createHash('sha256')
    .update(`ashby\0${tenant.toLowerCase()}`)
    .digest('hex');
}

function compareCatalogTenants(left, right) {
  const leftHash = hashCatalogTenant(left);
  const rightHash = hashCatalogTenant(right);
  if (leftHash < rightHash) return -1;
  if (leftHash > rightHash) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function serializableTarget(target) {
  return {
    sequence: target.sequence,
    provider: target.provider,
    tenant: target.tenant,
    name: target.name,
    careers_url: target.careers_url,
    targetClass: target.targetClass,
    reason: target.reason,
    catalogRef: target.catalog ? 'ashby' : null,
  };
}

function trackedTargets(portalConfig, providers) {
  const targets = [];
  const rejections = [];
  const entries = Array.isArray(portalConfig.tracked_companies)
    ? portalConfig.tracked_companies
    : [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      rejections.push({
        reason: 'invalid_portal_entry',
        candidate: null,
        details: { index, entry },
      });
      continue;
    }
    if (entry.enabled === false) continue;
    if (typeof entry.name !== 'string' || entry.name.trim() === '') {
      rejections.push({
        reason: 'invalid_portal_entry',
        candidate: null,
        details: { index, entry },
      });
      continue;
    }

    const resolved = resolveProvider(entry, providers);
    if (!resolved) {
      rejections.push({
        reason: 'provider_not_resolved',
        candidate: null,
        details: { index, company: entry.name },
      });
      continue;
    }
    if (resolved.error) {
      rejections.push({
        reason: 'provider_resolution_error',
        candidate: null,
        details: {
          index,
          company: entry.name,
          error: resolved.error,
        },
      });
      continue;
    }

    try {
      const tenant = deriveTrackedTenant(entry, resolved.provider.id);
      targets.push({
        ...entry,
        name: entry.name.trim(),
        careers_url: entry.careers_url.trim(),
        provider: resolved.provider.id,
        tenant,
        targetClass: 'priority',
        reason: 'tracked_company',
        catalog: null,
        _provider: resolved.provider,
      });
    } catch (error) {
      rejections.push({
        reason: 'invalid_portal_entry',
        candidate: null,
        details: {
          index,
          company: entry.name,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  return { targets, rejections };
}

export function buildTargetPlan({
  portalConfig,
  companyOverrides,
  discoveryPolicy,
  ashbyCatalog = null,
  providers,
  mode,
  generatedAt = new Date(),
}) {
  requireObject(portalConfig, 'portals config');
  if (!(providers instanceof Map)) {
    throw new Error('providers must be a Map');
  }
  normalizeMode(mode);

  const generatedAtDate = generatedAt instanceof Date
    ? generatedAt
    : new Date(generatedAt);
  if (Number.isNaN(generatedAtDate.getTime())) {
    throw new Error('generatedAt must be a valid date');
  }

  const policy = readAshbyPolicy(discoveryPolicy);
  const overrides = readOverrides(companyOverrides);
  const disabledKeys = new Set(
    overrides.disabledAshby.map((tenant) => targetKey('ashby', tenant)),
  );

  const tracked = trackedTargets(portalConfig, providers);
  const priorityTargets = [];
  const seen = new Set();
  let deduplicated = 0;
  let disabledRemoved = 0;

  function addPriority(target) {
    const key = targetKey(target.provider, target.tenant);
    if (target.provider === 'ashby' && disabledKeys.has(key)) {
      disabledRemoved += 1;
      return;
    }
    if (seen.has(key)) {
      deduplicated += 1;
      return;
    }
    seen.add(key);
    priorityTargets.push(target);
  }

  for (const target of tracked.targets) addPriority(target);

  const ashbyProvider = providers.get('ashby');
  if (overrides.priorityAshby.length > 0 && !ashbyProvider) {
    throw new Error('Ashby priority overrides require the ashby provider');
  }
  for (const tenant of overrides.priorityAshby) {
    addPriority({
      name: tenant,
      careers_url: `https://jobs.ashbyhq.com/${tenant}`,
      enabled: true,
      provider: 'ashby',
      tenant,
      targetClass: 'priority',
      reason: 'operator_priority',
      catalog: null,
      _provider: ashbyProvider,
    });
  }

  const normalTargets = [];
  let catalogMetadata = null;
  const includeCatalog = mode === 'offline' && policy.catalogEnabled;

  if (includeCatalog) {
    if (!ashbyProvider) {
      throw new Error('Ashby catalog scanning requires the ashby provider');
    }
    if (!ashbyCatalog) {
      throw new Error(
        'Ashby catalog is required for catalog-enabled offline planning. '
        + 'Run "catalog sync ashby" first.',
      );
    }
    validateAshbyCatalogEnvelope(ashbyCatalog);

    catalogMetadata = {
      source: ashbyCatalog.source,
      rawSha256: ashbyCatalog.rawSha256,
      fetchedAtUtc: ashbyCatalog.fetchedAtUtc,
      acceptedItemCount: ashbyCatalog.acceptedItemCount,
    };

    const ordered = [...ashbyCatalog.tenants].sort(compareCatalogTenants);
    for (const tenant of ordered) {
      const key = targetKey('ashby', tenant);
      if (disabledKeys.has(key)) continue;
      if (seen.has(key)) {
        deduplicated += 1;
        continue;
      }
      if (normalTargets.length >= policy.maxNormalTargets) break;

      seen.add(key);
      normalTargets.push({
        name: tenant,
        careers_url: `https://jobs.ashbyhq.com/${tenant}`,
        enabled: true,
        provider: 'ashby',
        tenant,
        targetClass: 'normal',
        reason: 'ashby_catalog',
        catalog: catalogMetadata,
        _provider: ashbyProvider,
      });
    }
  }

  const runtimeTargets = [...priorityTargets, ...normalTargets]
    .map((target, sequence) => ({ ...target, sequence }));

  const plan = {
    schemaVersion: 1,
    generatedAtUtc: generatedAtDate.toISOString(),
    mode,
    catalogs: {
      ashby: catalogMetadata,
    },
    limits: {
      ashbyNormalTargets: includeCatalog ? policy.maxNormalTargets : 0,
      phase2HardMaximum: PHASE2_MAX_NORMAL_ASHBY_TARGETS,
    },
    counts: {
      priority: priorityTargets.length,
      normal: normalTargets.length,
      disabled: disabledKeys.size,
      disabledRemoved,
      deduplicated,
      planningRejected: tracked.rejections.length,
    },
    targets: runtimeTargets.map(serializableTarget),
  };

  return {
    plan,
    portalConfig,
    planningRejections: tracked.rejections,
    runtimeTargets,
  };
}

export async function buildTargetPlanFromFiles({
  portalsPath,
  companyOverridesPath,
  discoveryPolicyPath,
  ashbyCatalogPath,
  providers,
  mode,
  generatedAt = new Date(),
}) {
  const [portalsText, overridesText, policyText] = await Promise.all([
    readFile(portalsPath, 'utf8'),
    readFile(companyOverridesPath, 'utf8'),
    readFile(discoveryPolicyPath, 'utf8'),
  ]);

  const portalConfig = parseYaml(portalsText, 'portals config');
  const companyOverrides = parseYaml(overridesText, 'company overrides');
  const discoveryPolicy = parseYaml(policyText, 'discovery policy');
  const policy = readAshbyPolicy(discoveryPolicy);

  let ashbyCatalog = null;
  if (mode === 'offline' && policy.catalogEnabled) {
    let text;
    try {
      text = await readFile(ashbyCatalogPath, 'utf8');
    } catch (error) {
      throw new Error(
        `Ashby catalog is not readable: ${ashbyCatalogPath}. `
        + 'Run "catalog sync ashby" first.',
        { cause: error },
      );
    }
    try {
      ashbyCatalog = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `Ashby catalog is not valid JSON: ${ashbyCatalogPath}`,
        { cause: error },
      );
    }
  }

  return buildTargetPlan({
    portalConfig,
    companyOverrides,
    discoveryPolicy,
    ashbyCatalog,
    providers,
    mode,
    generatedAt,
  });
}
