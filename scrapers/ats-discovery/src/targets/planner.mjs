import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';

import {
  CATALOG_PROVIDER_IDS,
  catalogItemKey,
  catalogItemToPortalEntry,
  normalizeCatalogItem,
  validateProviderCatalogEnvelope,
} from '../catalogs/provider-catalog.mjs';
import {
  getProviderPolicy,
  parseDiscoveryPolicy,
} from '../policy/discovery-policy.mjs';
import { resolveProvider } from '../providers/_registry.mjs';
import { targetHealthIdentity } from '../providers/_variant.mjs';
import { aggregateCatalogSweeps } from './aggregate-catalog-sweep.mjs';
import {
  loadTenantState,
  tenantStateKey,
  tenantStateMaps,
} from '../state/tenant-state.mjs';


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

function normalizeCatalogTargetLimit(value) {
  if (value == null) return 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('catalogTargetLimit must be a non-negative integer');
  }
  return value;
}

function normalizeMode(mode) {
  if (!['offline', 'preflight', 'import'].includes(mode)) {
    throw new Error(`Unsupported scan mode: ${mode}`);
  }
  return mode;
}

function normalizeOverrideItems(provider, value, name) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);

  const items = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const result = normalizeCatalogItem(provider, value[index]);
    if (!result.ok) {
      throw new Error(`${name}[${index}] is invalid (${result.reason})`);
    }
    const key = catalogItemKey(provider, result.item);
    if (!seen.has(key)) {
      seen.add(key);
      items.push(result.item);
    }
  }
  return items;
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
  const priorityByProvider = {};
  const disabledByProvider = {};
  for (const provider of CATALOG_PROVIDER_IDS) {
    priorityByProvider[provider] = normalizeOverrideItems(
      provider,
      priority[provider],
      `company overrides.priority.${provider}`,
    );
    disabledByProvider[provider] = normalizeOverrideItems(
      provider,
      disabled[provider],
      `company overrides.disabled.${provider}`,
    );
  }
  return { priorityByProvider, disabledByProvider };
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

function deriveTrackedTenant(entry, provider) {
  if (typeof entry.provider_tenant === 'string' && entry.provider_tenant.trim()) {
    return entry.provider_tenant.trim();
  }
  if (typeof provider?.tenant === 'function') {
    const tenant = provider.tenant(entry);
    if (typeof tenant !== 'string' || tenant.trim() === '') {
      throw new Error(
        `Provider ${provider.id} could not derive a tenant for ${entry.name}`,
      );
    }
    return tenant.trim();
  }
  const parsed = parseCareersUrl(entry.careers_url, entry.name);
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (['greenhouse', 'lever', 'ashby'].includes(provider?.id)) {
    if (!segments[0]) {
      throw new Error(`Tracked company ${entry.name} URL has no provider tenant`);
    }
    return segments[0];
  }
  return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/$/, '')}`;
}

function targetKey(provider, tenant, providerVariant = null) {
  return tenantStateKey(provider, tenant, providerVariant);
}

function targetStateKey(target) {
  return targetKey(target.provider, target.tenant, target.providerVariant);
}

function hashCatalogTarget(provider, tenant) {
  return createHash('sha256')
    .update(`${provider}\0${tenant.toLowerCase()}`)
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
  const leftHash = hashCatalogTarget(left.provider, left.tenant);
  const rightHash = hashCatalogTarget(right.provider, right.tenant);
  if (leftHash < rightHash) return -1;
  if (leftHash > rightHash) return 1;
  return left.tenant.localeCompare(right.tenant);
}

function boundedInteger(value, fallback, name, { min = 0, max = 100000 } = {}) {
  const result = value == null ? fallback : value;
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return result;
}

function canarySettings(entry, index) {
  const detailSampleSize = boundedInteger(
    entry.detail_sample_size ?? entry.detailSampleSize,
    3,
    `provider_canaries[${index}].detail_sample_size`,
    { min: 0, max: 10 },
  );
  const minimumDetailSuccesses = boundedInteger(
    entry.minimum_detail_successes ?? entry.minimumDetailSuccesses,
    detailSampleSize > 0 ? 1 : 0,
    `provider_canaries[${index}].minimum_detail_successes`,
    { min: 0, max: detailSampleSize },
  );
  return {
    minimumJobs: boundedInteger(
      entry.minimum_jobs ?? entry.minimumJobs,
      1,
      `provider_canaries[${index}].minimum_jobs`,
      { min: 1, max: 100000 },
    ),
    detailSampleSize,
    minimumDetailSuccesses,
    intervalHours: boundedInteger(
      entry.interval_hours ?? entry.intervalHours,
      24,
      `provider_canaries[${index}].interval_hours`,
      { min: 1, max: 24 * 30 },
    ),
  };
}

function trackedTargets(portalConfig, providers) {
  const targets = [];
  const rejections = [];
  const trackedEntries = Array.isArray(portalConfig.tracked_companies)
    ? portalConfig.tracked_companies.map((entry, index) => ({
      entry,
      index,
      source: 'tracked_companies',
      healthOnly: false,
    }))
    : [];
  const canaryEntries = Array.isArray(portalConfig.provider_canaries)
    ? portalConfig.provider_canaries.map((entry, index) => ({
      entry,
      index,
      source: 'provider_canaries',
      healthOnly: true,
    }))
    : [];

  for (const descriptor of [...trackedEntries, ...canaryEntries]) {
    const {
      entry,
      index,
      source,
      healthOnly,
    } = descriptor;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      rejections.push({
        reason: 'invalid_portal_entry',
        candidate: null,
        details: { source, index, entry },
      });
      continue;
    }
    if (entry.enabled === false) continue;
    if (typeof entry.name !== 'string' || entry.name.trim() === '') {
      rejections.push({
        reason: 'invalid_portal_entry',
        candidate: null,
        details: { source, index, entry },
      });
      continue;
    }

    const resolved = resolveProvider(entry, providers);
    if (!resolved) {
      rejections.push({
        reason: 'provider_not_resolved',
        candidate: null,
        details: { source, index, company: entry.name },
      });
      continue;
    }
    if (resolved.error) {
      rejections.push({
        reason: 'provider_resolution_error',
        candidate: null,
        details: {
          source,
          index,
          company: entry.name,
          error: resolved.error,
        },
      });
      continue;
    }

    try {
      const target = {
        ...entry,
        name: entry.name.trim(),
        careers_url: entry.careers_url.trim(),
        provider: resolved.provider.id,
        tenant: deriveTrackedTenant(entry, resolved.provider),
        sourceOrigin: typeof resolved.provider.sourceOrigin === 'function'
          ? resolved.provider.sourceOrigin(entry)
          : null,
        targetClass: 'priority',
        reason: healthOnly ? 'provider_canary' : 'tracked_company',
        healthOnly,
        canary: healthOnly ? canarySettings(entry, index) : null,
        catalog: null,
        _provider: resolved.provider,
      };
      Object.assign(target, targetHealthIdentity(target));
      targets.push(target);
    } catch (error) {
      rejections.push({
        reason: 'invalid_portal_entry',
        candidate: null,
        details: {
          source,
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

function targetWithSchedule(
  target,
  state,
  providerPolicy,
  now,
  bucket,
  useScheduledLookback,
) {
  const lookback = useScheduledLookback
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
    providerVariant: target.providerVariant ?? null,
    healthPartition: target.healthPartition ?? target.provider,
    tenant: target.tenant,
    name: target.name,
    careers_url: target.careers_url,
    targetClass: target.targetClass,
    reason: target.reason,
    catalogRef: target.catalog?.provider ?? null,
    health: target.health,
    scheduleBucket: target.scheduleBucket,
    lookbackStartUtc: target.lookbackStartUtc,
    lookbackUnbounded: target.lookbackUnbounded,
    healthOnly: target.healthOnly === true,
    canary: target.canary ?? null,
    canaryAttached: target.canaryAttached === true,
  };
}

function skippedSample(target, reason, state) {
  return {
    provider: target.provider,
    providerVariant: target.providerVariant ?? null,
    healthPartition: target.healthPartition ?? target.provider,
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

function catalogMetadata(provider, catalog) {
  return {
    provider,
    source: catalog.source,
    rawSha256: catalog.rawSha256,
    fetchedAtUtc: catalog.fetchedAtUtc,
    acceptedItemCount: catalog.acceptedItemCount,
    eligibleItemCount: 0,
    dueItemCount: 0,
    plannedTargetCount: 0,
  };
}

function catalogTarget(provider, item, metadata, providerPlugin) {
  const entry = catalogItemToPortalEntry(provider, item);
  const target = {
    ...entry,
    enabled: true,
    tenant: entry.provider_tenant,
    targetClass: 'normal',
    reason: `${provider}_catalog`,
    healthOnly: false,
    canary: null,
    catalog: metadata,
    _provider: providerPlugin,
  };
  Object.assign(target, targetHealthIdentity(target));
  return target;
}

function operatorPriorityTarget(provider, item, providerPlugin) {
  const entry = catalogItemToPortalEntry(provider, item);
  const target = {
    ...entry,
    enabled: true,
    tenant: entry.provider_tenant,
    targetClass: 'priority',
    reason: 'operator_priority',
    healthOnly: false,
    canary: null,
    catalog: null,
    _provider: providerPlugin,
  };
  Object.assign(target, targetHealthIdentity(target));
  return target;
}

function emptyBucketCounts() {
  return Object.fromEntries(BUCKET_ORDER.map((key) => [key, 0]));
}

function aggregateBucketCounts(perProvider, field) {
  const result = emptyBucketCounts();
  for (const value of Object.values(perProvider)) {
    for (const bucket of BUCKET_ORDER) result[bucket] += value[field][bucket];
  }
  return result;
}

export function buildTargetPlan({
  portalConfig,
  companyOverrides,
  discoveryPolicy,
  catalogs = null,
  ashbyCatalog = null,
  tenantState,
  providers,
  mode,
  generatedAt = new Date(),
  catalogTargetLimit = 0,
}) {
  requireObject(portalConfig, 'portals config');
  if (!(providers instanceof Map)) throw new Error('providers must be a Map');
  normalizeMode(mode);
  const requestedCatalogTargetLimit = normalizeCatalogTargetLimit(catalogTargetLimit);
  if (mode === 'offline' && requestedCatalogTargetLimit > 0) {
    throw new Error('offline catalog target count must come from discovery policy');
  }

  const now = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
  if (Number.isNaN(now.getTime())) throw new Error('generatedAt must be a valid date');
  const policy = discoveryPolicy?.schemaVersion === 1
    ? discoveryPolicy
    : parseDiscoveryPolicy(discoveryPolicy);
  const overrides = readOverrides(companyOverrides);
  const stateMaps = tenantStateMaps(tenantState);
  const catalogValues = { ...(catalogs ?? {}) };
  if (ashbyCatalog != null && catalogValues.ashby == null) catalogValues.ashby = ashbyCatalog;

  const disabledKeys = new Set();
  for (const provider of CATALOG_PROVIDER_IDS) {
    for (const item of overrides.disabledByProvider[provider]) {
      const entry = catalogItemToPortalEntry(provider, item);
      disabledKeys.add(targetKey(provider, entry.provider_tenant, null));
    }
  }

  const tracked = trackedTargets(portalConfig, providers);
  const rawPriority = [];
  const seen = new Map();
  let deduplicated = 0;
  let disabledRemoved = 0;

  function addPriority(target) {
    const key = targetStateKey(target);
    if (disabledKeys.has(key)) {
      disabledRemoved += 1;
      return;
    }
    if (seen.has(key)) {
      deduplicated += 1;
      const existing = seen.get(key);
      if (existing.canary == null && target.canary != null) {
        existing.canary = target.canary;
        existing.canaryAttached = true;
      }
      return;
    }
    seen.set(key, target);
    rawPriority.push(target);
  }

  for (const target of tracked.targets) addPriority(target);
  for (const provider of CATALOG_PROVIDER_IDS) {
    const plugin = providers.get(provider);
    const priorityItems = overrides.priorityByProvider[provider];
    if (priorityItems.length > 0 && !plugin) {
      throw new Error(`${provider} priority overrides require the ${provider} provider`);
    }
    for (const item of priorityItems) addPriority(operatorPriorityTarget(provider, item, plugin));
  }

  const skippedCounts = { notDue: 0, providerCooldown: 0, budget: 0 };
  const skippedSamples = [];
  const partitionStats = new Map();
  function partitionStat(target) {
    const identity = targetHealthIdentity(target);
    if (!partitionStats.has(identity.healthPartition)) {
      partitionStats.set(identity.healthPartition, {
        provider: identity.provider,
        providerVariant: identity.providerVariant,
        healthPartition: identity.healthPartition,
        selectedTargets: 0,
        selectedCanaries: 0,
        selectedNormal: 0,
        skippedNotDue: 0,
        skippedProviderCooldown: 0,
        skippedNormalBudget: 0,
      });
    }
    return partitionStats.get(identity.healthPartition);
  }
  function recordSkipped(target, reason, state) {
    const stats = partitionStat(target);
    if (reason === 'not_due') { skippedCounts.notDue += 1; stats.skippedNotDue += 1; }
    if (reason === 'provider_cooldown') { skippedCounts.providerCooldown += 1; stats.skippedProviderCooldown += 1; }
    if (reason === 'normal_budget') { skippedCounts.budget += 1; stats.skippedNormalBudget += 1; }
    if (skippedSamples.length < MAX_SKIPPED_SAMPLES) {
      skippedSamples.push(skippedSample(target, reason, state));
    }
  }

  const selectedPriority = [];
  for (const target of rawPriority) {
    const providerPolicy = getProviderPolicy(policy, target.provider);
    const state = stateMaps.tenants.get(targetStateKey(target)) ?? null;
    if (mode === 'offline') {
      const providerState = stateMaps.providers.get(target.healthPartition);
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
      mode === 'offline',
    ));
  }

  const liveCatalogRequested = mode !== 'offline' && requestedCatalogTargetLimit > 0;
  const enabledCatalogProviders = CATALOG_PROVIDER_IDS.filter(
    (provider) => getProviderPolicy(policy, provider).catalogEnabled,
  );
  const includeCatalogProviders = (mode === 'offline' || liveCatalogRequested)
    ? enabledCatalogProviders
    : [];
  if (liveCatalogRequested && enabledCatalogProviders.length === 0) {
    throw new Error('Live catalog scanning requires at least one catalog-enabled provider');
  }
  const policyCapacity = enabledCatalogProviders.reduce((total, provider) => {
    const next = total + getProviderPolicy(policy, provider).maxNormalTargetsPerRun;
    if (!Number.isSafeInteger(next)) {
      throw new Error('Combined catalog policy capacity exceeds JavaScript safe integer range');
    }
    return next;
  }, 0);

  const catalogPlans = {};
  const catalogMetadataByProvider = Object.fromEntries(
    CATALOG_PROVIDER_IDS.map((provider) => [provider, null]),
  );
  for (const provider of includeCatalogProviders) {
    const plugin = providers.get(provider);
    if (!plugin) throw new Error(`${provider} catalog scanning requires the ${provider} provider`);
    const rawCatalog = catalogValues[provider];
    if (!rawCatalog) {
      throw new Error(
        `${provider} catalog is required for catalog-enabled planning. `
        + `Run "catalog sync ${provider}" first.`,
      );
    }
    const catalog = validateProviderCatalogEnvelope(provider, rawCatalog);
    const metadata = catalogMetadata(provider, catalog);
    catalogMetadataByProvider[provider] = metadata;
    const providerPolicy = getProviderPolicy(policy, provider);
    const buckets = new Map(BUCKET_ORDER.map((bucket) => [bucket, []]));
    const populationByBucket = emptyBucketCounts();
    const dueByBucket = emptyBucketCounts();
    const providerState = stateMaps.providers.get(provider);
    const providerBlocked = providerCooldownActive(providerState, now);

    for (const item of catalog.items) {
      const target = catalogTarget(provider, item, metadata, plugin);
      const key = targetStateKey(target);
      if (disabledKeys.has(key) || seen.has(key)) {
        if (seen.has(key)) deduplicated += 1;
        continue;
      }
      metadata.eligibleItemCount += 1;
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
      metadata.dueItemCount += 1;
      buckets.get(bucket).push(targetWithSchedule(
        target,
        state,
        providerPolicy,
        now,
        bucket,
        true,
      ));
    }
    const queuesByBucket = {};
    for (const bucket of BUCKET_ORDER) {
      buckets.get(bucket).sort(compareScheduledTargets);
      queuesByBucket[bucket] = buckets.get(bucket);
    }
    catalogPlans[provider] = {
      provider,
      policy: providerPolicy,
      metadata,
      populationByBucket,
      dueByBucket,
      queuesByBucket,
      budget: providerPolicy.maxNormalTargetsPerRun,
      selected: [],
    };
  }

  const selectedNormal = [];
  const globalCatalogLimit = mode === 'offline'
    ? policyCapacity
    : Math.min(requestedCatalogTargetLimit, policyCapacity);
  const providerOrder = CATALOG_PROVIDER_IDS.filter((provider) => catalogPlans[provider]);
  // Preserve scheduler priority globally, then round-robin providers within
  // each bucket so a large catalog cannot starve a smaller provider.
  for (const bucket of BUCKET_ORDER) {
    let progress = true;
    while (selectedNormal.length < globalCatalogLimit && progress) {
      progress = false;
      for (const provider of providerOrder) {
        if (selectedNormal.length >= globalCatalogLimit) break;
        const plan = catalogPlans[provider];
        const queue = plan.queuesByBucket[bucket];
        if (plan.selected.length >= plan.budget || queue.length === 0) continue;
        const target = queue.shift();
        plan.selected.push(target);
        plan.metadata.plannedTargetCount += 1;
        selectedNormal.push(target);
        progress = true;
      }
    }
  }
  for (const plan of Object.values(catalogPlans)) {
    for (const bucket of BUCKET_ORDER) {
      for (const target of plan.queuesByBucket[bucket]) {
        recordSkipped(target, 'normal_budget', target.state);
      }
    }
  }

  const runtimeTargets = [...selectedPriority, ...selectedNormal]
    .map((target, sequence) => ({ ...target, sequence }));
  for (const target of runtimeTargets) {
    const stats = partitionStat(target);
    stats.selectedTargets += 1;
    if (target.canary != null) stats.selectedCanaries += 1;
    if (target.targetClass === 'normal') stats.selectedNormal += 1;
  }
  const healthPartitions = Object.fromEntries(
    [...partitionStats.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );

  const catalogSweeps = {};
  for (const [provider, plan] of Object.entries(catalogPlans)) {
    catalogSweeps[provider] = catalogSweep({
      populationByBucket: plan.populationByBucket,
      dueByBucket: plan.dueByBucket,
      maxTargets: plan.budget,
      targetDays: plan.policy.targetFullSweepDays,
    });
  }
  const aggregateTargetDays = Object.values(catalogPlans).length === 0
    ? 3
    : Math.max(...Object.values(catalogPlans).map((plan) => plan.policy.targetFullSweepDays));
  const sweep = aggregateCatalogSweeps(catalogSweeps, {
    globalCatalogLimit,
    targetDays: aggregateTargetDays,
  });

  const normalTargetsByProvider = Object.fromEntries(
    CATALOG_PROVIDER_IDS.map((provider) => [provider, catalogPlans[provider]?.selected.length ?? 0]),
  );
  const catalogEligible = Object.values(catalogMetadataByProvider)
    .filter(Boolean)
    .reduce((total, metadata) => total + metadata.eligibleItemCount, 0);
  const plan = {
    schemaVersion: 4,
    generatedAtUtc: now.toISOString(),
    mode,
    catalogs: catalogMetadataByProvider,
    catalogSweeps,
    limits: {
      normalTargetsByProvider,
      catalogTargetsRequested: requestedCatalogTargetLimit,
      catalogTargetsEffective: globalCatalogLimit,
      combinedPolicyCapacity: policyCapacity,
      liveCatalogRequested,
      normalTargetsHardMaximum: null,
      phase3HardMaximum: null,
      // Compatibility field retained for existing dashboards/tests.
      ashbyNormalTargets: normalTargetsByProvider.ashby,
    },
    sweep,
    healthPartitions,
    counts: {
      priority: selectedPriority.length,
      canary: selectedPriority.filter((target) => target.canary != null).length,
      normal: selectedNormal.length,
      disabled: disabledKeys.size,
      disabledRemoved,
      deduplicated,
      planningRejected: tracked.rejections.length,
      canaryPlanningRejected: tracked.rejections.filter(
        (item) => item.details?.source === 'provider_canaries',
      ).length,
      catalogEligible,
      catalogEligibleByProvider: Object.fromEntries(
        CATALOG_PROVIDER_IDS.map((provider) => [
          provider,
          catalogMetadataByProvider[provider]?.eligibleItemCount ?? 0,
        ]),
      ),
      skippedNotDue: skippedCounts.notDue,
      skippedProviderCooldown: skippedCounts.providerCooldown,
      skippedNormalBudget: skippedCounts.budget,
      skippedTotal: skippedCounts.notDue + skippedCounts.providerCooldown + skippedCounts.budget,
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
  catalogPaths = null,
  ashbyCatalogPath = null,
  tenantStatePath,
  providers,
  mode,
  generatedAt = new Date(),
  catalogTargetLimit = 0,
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
  const resolvedPaths = {
    ...(catalogPaths ?? {}),
    ...(ashbyCatalogPath && !(catalogPaths?.ashby) ? { ashby: ashbyCatalogPath } : {}),
  };
  const shouldLoadCatalogs = mode === 'offline' || catalogTargetLimit > 0;
  const loadedCatalogs = {};
  if (shouldLoadCatalogs) {
    for (const provider of CATALOG_PROVIDER_IDS) {
      if (!getProviderPolicy(policy, provider).catalogEnabled) continue;
      const catalogPath = resolvedPaths[provider];
      if (typeof catalogPath !== 'string' || !catalogPath.trim()) {
        throw new Error(`${provider} catalog path is not configured`);
      }
      let text;
      try {
        text = await readFile(catalogPath, 'utf8');
      } catch (error) {
        throw new Error(
          `${provider} catalog is not readable: ${catalogPath}. `
          + `Run "catalog sync ${provider}" first.`,
          { cause: error },
        );
      }
      try {
        loadedCatalogs[provider] = JSON.parse(text);
      } catch (error) {
        throw new Error(`${provider} catalog is not valid JSON: ${catalogPath}`, { cause: error });
      }
    }
  }
  return buildTargetPlan({
    portalConfig,
    companyOverrides,
    discoveryPolicy: policy,
    catalogs: loadedCatalogs,
    tenantState,
    providers,
    mode,
    generatedAt,
    catalogTargetLimit,
  });
}
