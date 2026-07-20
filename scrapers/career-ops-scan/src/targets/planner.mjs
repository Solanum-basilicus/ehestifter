import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';

import {
  validateAshbyCatalogEnvelope,
  validateAshbyTenant,
} from '../catalogs/ashby-catalog.mjs';
import {
  getProviderPolicy,
  parseDiscoveryPolicy,
  PHASE3_MAX_NORMAL_TARGETS_PER_RUN,
} from '../policy/discovery-policy.mjs';
import { resolveProvider } from '../providers/_registry.mjs';
import {
  loadTenantState,
  tenantStateKey,
  tenantStateMaps,
} from '../state/tenant-state.mjs';

export { PHASE3_MAX_NORMAL_TARGETS_PER_RUN };

const MAX_SKIPPED_SAMPLES = 50;

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
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);

  const tenants = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const result = validateAshbyTenant(value[index]);
    if (!result.ok) {
      throw new Error(`${name}[${index}] is invalid (${result.reason})`);
    }
    const key = result.tenant.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      tenants.push(result.tenant);
    }
  }
  return tenants;
}

function readOverrides(companyOverrides) {
  const overrides = requireSchemaVersion(companyOverrides, 'company overrides');
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
    throw new Error(`Tracked company ${companyName} careers_url must use HTTP(S)`);
  }
  return parsed;
}

function deriveTrackedTenant(entry, providerId) {
  if (typeof entry.provider_tenant === 'string' && entry.provider_tenant.trim()) {
    return entry.provider_tenant.trim();
  }
  const parsed = parseCareersUrl(entry.careers_url, entry.name);
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (['greenhouse', 'lever', 'ashby'].includes(providerId)) {
    if (!segments[0]) {
      throw new Error(`Tracked company ${entry.name} URL has no provider tenant`);
    }
    return segments[0];
  }
  return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/$/, '')}`;
}

function targetKey(provider, tenant) {
  return tenantStateKey(provider, tenant);
}

function hashCatalogTenant(tenant) {
  return createHash('sha256')
    .update(`ashby\0${tenant.toLowerCase()}`)
    .digest('hex');
}

function compareNullableDates(left, right) {
  const leftValue = left == null ? Number.NEGATIVE_INFINITY : Date.parse(left);
  const rightValue = right == null ? Number.NEGATIVE_INFINITY : Date.parse(right);
  return leftValue - rightValue;
}

function compareScheduledTargets(left, right) {
  const due = compareNullableDates(
    left.state?.nextEligibleScanAtUtc,
    right.state?.nextEligibleScanAtUtc,
  );
  if (due !== 0) return due;
  const attempt = compareNullableDates(
    left.state?.lastAttemptAtUtc,
    right.state?.lastAttemptAtUtc,
  );
  if (attempt !== 0) return attempt;
  const leftHash = hashCatalogTenant(left.tenant);
  const rightHash = hashCatalogTenant(right.tenant);
  if (leftHash < rightHash) return -1;
  if (leftHash > rightHash) return 1;
  return left.tenant.localeCompare(right.tenant);
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
        details: { index, company: entry.name, error: resolved.error },
      });
      continue;
    }

    try {
      targets.push({
        ...entry,
        name: entry.name.trim(),
        careers_url: entry.careers_url.trim(),
        provider: resolved.provider.id,
        tenant: deriveTrackedTenant(entry, resolved.provider.id),
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

function providerCooldownActive(providerState, now) {
  return providerState?.health === 'cooldown'
    && providerState.cooldownUntilUtc != null
    && Date.parse(providerState.cooldownUntilUtc) > now.getTime();
}

function tenantDue(state, now) {
  return state?.nextEligibleScanAtUtc == null
    || Date.parse(state.nextEligibleScanAtUtc) <= now.getTime();
}

function scheduleBucket(state) {
  switch (state?.health) {
    case 'active': return 'recent_activity';
    case 'cooldown':
    case 'temporarily_failed': return 'recovery';
    case 'suspected_dead':
    case 'confirmed_dead': return 'dead_reprobe';
    case 'long_empty': return 'long_empty';
    default: return 'healthy';
  }
}

const BUCKET_ORDER = Object.freeze([
  'recent_activity',
  'recovery',
  'dead_reprobe',
  'long_empty',
  'healthy',
]);

function lookbackWindow(state, providerPolicy, now) {
  if (
    providerPolicy.lookback.deadReprobeUnbounded
    && ['suspected_dead', 'confirmed_dead'].includes(state?.health)
  ) {
    return { startUtc: null, unbounded: true };
  }

  const floor = now.getTime() - providerPolicy.lookback.maxHours * 3_600_000;
  let requested;
  if (state?.lastSuccessfulAtUtc) {
    requested = Date.parse(state.lastSuccessfulAtUtc)
      - providerPolicy.lookback.overlapHours * 3_600_000;
  } else {
    requested = now.getTime()
      - providerPolicy.lookback.initialHours * 3_600_000;
  }
  return {
    startUtc: new Date(Math.max(floor, requested)).toISOString(),
    unbounded: false,
  };
}

function targetWithSchedule(target, state, providerPolicy, now, bucket, mode) {
  const lookback = mode === 'offline'
    ? lookbackWindow(state, providerPolicy, now)
    : { startUtc: null, unbounded: false };
  return {
    ...target,
    state,
    health: state?.health ?? 'healthy',
    scheduleBucket: bucket,
    lookbackStartUtc: lookback.startUtc,
    lookbackUnbounded: lookback.unbounded,
  };
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
    health: target.health,
    scheduleBucket: target.scheduleBucket,
    lookbackStartUtc: target.lookbackStartUtc,
    lookbackUnbounded: target.lookbackUnbounded,
  };
}

function skippedSample(target, reason, state) {
  return {
    provider: target.provider,
    tenant: target.tenant,
    targetClass: target.targetClass,
    reason,
    health: state?.health ?? 'healthy',
    nextEligibleScanAtUtc: state?.nextEligibleScanAtUtc ?? null,
  };
}

function catalogSweep({ populationByBucket, dueByBucket, maxTargets, targetDays }) {
  const healthyRotationTenants = populationByBucket.healthy;
  const promotedDailyTenants = populationByBucket.recent_activity;
  const exceptionalDueTenants = dueByBucket.recovery
    + dueByBucket.dead_reprobe
    + dueByBucket.long_empty;
  const recommendedHealthyTargetsPerRun = healthyRotationTenants === 0
    ? 0
    : Math.ceil(healthyRotationTenants / targetDays);
  const recommendedNormalTargetsPerRun = promotedDailyTenants
    + exceptionalDueTenants
    + recommendedHealthyTargetsPerRun;
  const healthyBudget = Math.max(
    0,
    maxTargets - promotedDailyTenants - exceptionalDueTenants,
  );
  return {
    targetFullSweepDays: targetDays,
    healthyRotationTenants,
    promotedDailyTenants,
    exceptionalDueTenants,
    configuredNormalTargetsPerRun: maxTargets,
    recommendedHealthyTargetsPerRun,
    recommendedNormalTargetsPerRun,
    estimatedHealthySweepDays: healthyRotationTenants === 0
      ? 0
      : healthyBudget === 0
        ? null
        : Math.ceil(healthyRotationTenants / healthyBudget),
    feasibleAtConfiguredBudget:
      maxTargets >= recommendedNormalTargetsPerRun,
  };
}

export function buildTargetPlan({
  portalConfig,
  companyOverrides,
  discoveryPolicy,
  ashbyCatalog = null,
  tenantState,
  providers,
  mode,
  generatedAt = new Date(),
}) {
  requireObject(portalConfig, 'portals config');
  if (!(providers instanceof Map)) throw new Error('providers must be a Map');
  normalizeMode(mode);

  const now = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
  if (Number.isNaN(now.getTime())) throw new Error('generatedAt must be a valid date');

  const policy = discoveryPolicy?.schemaVersion === 1
    ? discoveryPolicy
    : parseDiscoveryPolicy(discoveryPolicy);
  const ashbyPolicy = getProviderPolicy(policy, 'ashby');
  const overrides = readOverrides(companyOverrides);
  const stateMaps = tenantStateMaps(tenantState);
  const disabledKeys = new Set(
    overrides.disabledAshby.map((tenant) => targetKey('ashby', tenant)),
  );

  const tracked = trackedTargets(portalConfig, providers);
  const rawPriority = [];
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
    rawPriority.push(target);
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

  const skippedCounts = {
    notDue: 0,
    providerCooldown: 0,
    budget: 0,
  };
  const skippedSamples = [];
  function recordSkipped(target, reason, state) {
    if (reason === 'not_due') skippedCounts.notDue += 1;
    if (reason === 'provider_cooldown') skippedCounts.providerCooldown += 1;
    if (reason === 'normal_budget') skippedCounts.budget += 1;
    if (skippedSamples.length < MAX_SKIPPED_SAMPLES) {
      skippedSamples.push(skippedSample(target, reason, state));
    }
  }

  const selectedPriority = [];
  for (const target of rawPriority) {
    const providerPolicy = getProviderPolicy(policy, target.provider);
    const state = stateMaps.tenants.get(targetKey(target.provider, target.tenant)) ?? null;
    if (mode === 'offline') {
      const providerState = stateMaps.providers.get(target.provider.toLowerCase());
      if (providerCooldownActive(providerState, now)) {
        recordSkipped(target, 'provider_cooldown', state);
        continue;
      }
      if (!tenantDue(state, now)) {
        recordSkipped(target, 'not_due', state);
        continue;
      }
    }
    selectedPriority.push(targetWithSchedule(
      target,
      state,
      providerPolicy,
      now,
      'priority',
      mode,
    ));
  }

  let catalogMetadata = null;
  let eligibleNormalCount = 0;
  const populationByBucket = Object.fromEntries(BUCKET_ORDER.map((key) => [key, 0]));
  const dueByBucket = Object.fromEntries(BUCKET_ORDER.map((key) => [key, 0]));
  const selectedNormal = [];
  const includeCatalog = mode === 'offline' && ashbyPolicy.catalogEnabled;

  if (includeCatalog) {
    if (!ashbyProvider) throw new Error('Ashby catalog scanning requires the ashby provider');
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

    const buckets = new Map(BUCKET_ORDER.map((bucket) => [bucket, []]));
    const providerState = stateMaps.providers.get('ashby');
    const providerBlocked = providerCooldownActive(providerState, now);

    for (const tenant of ashbyCatalog.tenants) {
      const key = targetKey('ashby', tenant);
      if (disabledKeys.has(key) || seen.has(key)) {
        if (seen.has(key)) deduplicated += 1;
        continue;
      }
      eligibleNormalCount += 1;
      const target = {
        name: tenant,
        careers_url: `https://jobs.ashbyhq.com/${tenant}`,
        enabled: true,
        provider: 'ashby',
        tenant,
        targetClass: 'normal',
        reason: 'ashby_catalog',
        catalog: catalogMetadata,
        _provider: ashbyProvider,
      };
      const state = stateMaps.tenants.get(key) ?? null;
      const bucket = scheduleBucket(state);
      populationByBucket[bucket] += 1;
      if (providerBlocked) {
        recordSkipped(target, 'provider_cooldown', state);
        continue;
      }
      if (!tenantDue(state, now)) {
        recordSkipped(target, 'not_due', state);
        continue;
      }
      dueByBucket[bucket] += 1;
      buckets.get(bucket).push(targetWithSchedule(
        target,
        state,
        ashbyPolicy,
        now,
        bucket,
        mode,
      ));
    }

    for (const bucket of BUCKET_ORDER) {
      buckets.get(bucket).sort(compareScheduledTargets);
      for (const target of buckets.get(bucket)) {
        if (selectedNormal.length >= ashbyPolicy.maxNormalTargetsPerRun) {
          recordSkipped(target, 'normal_budget', target.state);
          continue;
        }
        selectedNormal.push(target);
      }
    }
  }

  const runtimeTargets = [...selectedPriority, ...selectedNormal]
    .map((target, sequence) => ({ ...target, sequence }));
  const sweep = catalogSweep({
    populationByBucket,
    dueByBucket,
    maxTargets: ashbyPolicy.maxNormalTargetsPerRun,
    targetDays: ashbyPolicy.targetFullSweepDays,
  });

  const plan = {
    schemaVersion: 2,
    generatedAtUtc: now.toISOString(),
    mode,
    catalogs: { ashby: catalogMetadata },
    limits: {
      ashbyNormalTargets: includeCatalog
        ? ashbyPolicy.maxNormalTargetsPerRun
        : 0,
      phase3HardMaximum: PHASE3_MAX_NORMAL_TARGETS_PER_RUN,
    },
    sweep,
    counts: {
      priority: selectedPriority.length,
      normal: selectedNormal.length,
      disabled: disabledKeys.size,
      disabledRemoved,
      deduplicated,
      planningRejected: tracked.rejections.length,
      catalogEligible: eligibleNormalCount,
      skippedNotDue: skippedCounts.notDue,
      skippedProviderCooldown: skippedCounts.providerCooldown,
      skippedNormalBudget: skippedCounts.budget,
      skippedTotal:
        skippedCounts.notDue + skippedCounts.providerCooldown + skippedCounts.budget,
    },
    skippedSamples,
    targets: runtimeTargets.map(serializableTarget),
  };

  return {
    plan,
    policy,
    tenantState,
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
  tenantStatePath,
  providers,
  mode,
  generatedAt = new Date(),
}) {
  const [portalsText, overridesText, policyText, tenantState] = await Promise.all([
    readFile(portalsPath, 'utf8'),
    readFile(companyOverridesPath, 'utf8'),
    readFile(discoveryPolicyPath, 'utf8'),
    loadTenantState(tenantStatePath, { now: generatedAt }),
  ]);

  const portalConfig = parseYaml(portalsText, 'portals config');
  const companyOverrides = parseYaml(overridesText, 'company overrides');
  const rawPolicy = parseYaml(policyText, 'discovery policy');
  const policy = parseDiscoveryPolicy(rawPolicy);
  const ashbyPolicy = getProviderPolicy(policy, 'ashby');

  let ashbyCatalog = null;
  if (mode === 'offline' && ashbyPolicy.catalogEnabled) {
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
      throw new Error(`Ashby catalog is not valid JSON: ${ashbyCatalogPath}`, {
        cause: error,
      });
    }
  }

  return buildTargetPlan({
    portalConfig,
    companyOverrides,
    discoveryPolicy: policy,
    ashbyCatalog,
    tenantState,
    providers,
    mode,
    generatedAt,
  });
}
