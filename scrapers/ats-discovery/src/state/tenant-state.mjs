import { readFile } from 'node:fs/promises';

import { writeJsonAtomic } from '../io/atomic-json.mjs';
import { getProviderPolicy } from '../policy/discovery-policy.mjs';
import { providerHealthPartition } from '../providers/_variant.mjs';
import { isDurableProviderResult } from '../scan/provider-errors.mjs';

export const TENANT_HEALTH = Object.freeze([
  'healthy',
  'active',
  'long_empty',
  'cooldown',
  'temporarily_failed',
  'suspected_dead',
  'confirmed_dead',
]);

const HEALTH_SET = new Set(TENANT_HEALTH);
function validDateString(value, name, { nullable = true } = {}) {
  if (value == null && nullable) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${name} must be an ISO date string${nullable ? ' or null' : ''}`);
  }
  return new Date(value).toISOString();
}

function nonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}
function nullableNonNegativeInteger(value, name) {
  if (value == null) return null;
  return nonNegativeInteger(value, name);
}

function nullableFiniteNumber(value, name) {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number or null`);
  }
  return value;
}
function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function addMilliseconds(date, milliseconds) {
  return new Date(date.getTime() + milliseconds).toISOString();
}

function addHours(date, hours) {
  return addMilliseconds(date, hours * 3_600_000);
}

function addMinutes(date, minutes) {
  return addMilliseconds(date, minutes * 60_000);
}
export function tenantStateKey(provider, tenant, providerVariant = null) {
  return `${providerHealthPartition(provider, providerVariant)}::${String(tenant).toLowerCase()}`;
}

export function createEmptyTenantState(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) throw new Error('now must be a valid date');
  return {
    schemaVersion: 1,
    updatedAtUtc: date.toISOString(),
    providers: [],
    tenants: [],
  };
}
function validateProviderState(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`tenant state.providers[${index}] must be an object`);
  }
  const health = item.health ?? 'healthy';
  if (!['healthy', 'cooldown'].includes(health)) {
    throw new Error(`tenant state.providers[${index}].health is invalid`);
  }
  const provider = requireString(
    item.provider,
    `tenant state.providers[${index}].provider`,
  ).toLowerCase();
  const providerVariant = item.providerVariant == null
    ? null
    : requireString(
      item.providerVariant,
      `tenant state.providers[${index}].providerVariant`,
    ).toLowerCase();
  const healthPartition = item.healthPartition == null
    ? providerHealthPartition(provider, providerVariant)
    : requireString(
      item.healthPartition,
      `tenant state.providers[${index}].healthPartition`,
    ).toLowerCase();
  if (healthPartition !== providerHealthPartition(provider, providerVariant)) {
    throw new Error(
      `tenant state.providers[${index}].healthPartition does not match provider identity`,
    );
  }
  return {
    provider,
    providerVariant,
    healthPartition,
    health,
    cooldownUntilUtc: validDateString(
      item.cooldownUntilUtc,
      `tenant state.providers[${index}].cooldownUntilUtc`,
    ),
    lastBreakerAtUtc: validDateString(
      item.lastBreakerAtUtc,
      `tenant state.providers[${index}].lastBreakerAtUtc`,
    ),
    lastBreakerReason: item.lastBreakerReason == null
      ? null
      : requireString(
        item.lastBreakerReason,
        `tenant state.providers[${index}].lastBreakerReason`,
      ),
    lastRunAtUtc: validDateString(
      item.lastRunAtUtc,
      `tenant state.providers[${index}].lastRunAtUtc`,
    ),
    lastRequestsAttempted: nullableNonNegativeInteger(
      item.lastRequestsAttempted,
      `tenant state.providers[${index}].lastRequestsAttempted`,
    ),
    lastRateLimited: nullableNonNegativeInteger(
      item.lastRateLimited,
      `tenant state.providers[${index}].lastRateLimited`,
    ),
  };
}
function validateTenantEntry(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`tenant state.tenants[${index}] must be an object`);
  }
  const health = item.health ?? 'healthy';
  if (!HEALTH_SET.has(health)) {
    throw new Error(`tenant state.tenants[${index}].health is invalid`);
  }
  const provider = requireString(
    item.provider,
    `tenant state.tenants[${index}].provider`,
  ).toLowerCase();
  const providerVariant = item.providerVariant == null
    ? null
    : requireString(
      item.providerVariant,
      `tenant state.tenants[${index}].providerVariant`,
    ).toLowerCase();
  const healthPartition = item.healthPartition == null
    ? providerHealthPartition(provider, providerVariant)
    : requireString(
      item.healthPartition,
      `tenant state.tenants[${index}].healthPartition`,
    ).toLowerCase();
  if (healthPartition !== providerHealthPartition(provider, providerVariant)) {
    throw new Error(
      `tenant state.tenants[${index}].healthPartition does not match provider identity`,
    );
  }
  const tenant = requireString(
    item.tenant,
    `tenant state.tenants[${index}].tenant`,
  );
  return {
    provider,
    providerVariant,
    healthPartition,
    tenant,
    firstSeenAtUtc: validDateString(
      item.firstSeenAtUtc,
      `tenant state.tenants[${index}].firstSeenAtUtc`,
      { nullable: false },
    ),
    lastAttemptAtUtc: validDateString(
      item.lastAttemptAtUtc,
      `tenant state.tenants[${index}].lastAttemptAtUtc`,
    ),
    lastSuccessfulAtUtc: validDateString(
      item.lastSuccessfulAtUtc,
      `tenant state.tenants[${index}].lastSuccessfulAtUtc`,
    ),
    lastRelevantCandidateAtUtc: validDateString(
      item.lastRelevantCandidateAtUtc,
      `tenant state.tenants[${index}].lastRelevantCandidateAtUtc`,
    ),
    lastJobsReturned: nullableNonNegativeInteger(
      item.lastJobsReturned,
      `tenant state.tenants[${index}].lastJobsReturned`,
    ),
    lastCandidatesMatched: nullableNonNegativeInteger(
      item.lastCandidatesMatched ?? item.lastCandidatesRetained,
      `tenant state.tenants[${index}].lastCandidatesMatched`,
    ),
    lastCandidatesRetained: nullableNonNegativeInteger(
      item.lastCandidatesRetained,
      `tenant state.tenants[${index}].lastCandidatesRetained`,
    ),
    lastDurationMs: nullableFiniteNumber(
      item.lastDurationMs,
      `tenant state.tenants[${index}].lastDurationMs`,
    ),
    consecutiveFailures: nonNegativeInteger(
      item.consecutiveFailures ?? 0,
      `tenant state.tenants[${index}].consecutiveFailures`,
    ),
    consecutiveDurableFailures: nonNegativeInteger(
      item.consecutiveDurableFailures ?? 0,
      `tenant state.tenants[${index}].consecutiveDurableFailures`,
    ),
    consecutiveTransientFailures: nonNegativeInteger(
      item.consecutiveTransientFailures ?? 0,
      `tenant state.tenants[${index}].consecutiveTransientFailures`,
    ),
    consecutiveEmptySuccesses: nonNegativeInteger(
      item.consecutiveEmptySuccesses ?? 0,
      `tenant state.tenants[${index}].consecutiveEmptySuccesses`,
    ),
    consecutiveSuspiciousEmptyResults: nonNegativeInteger(
      item.consecutiveSuspiciousEmptyResults ?? 0,
      `tenant state.tenants[${index}].consecutiveSuspiciousEmptyResults`,
    ),
    lastNonEmptyAtUtc: validDateString(
      item.lastNonEmptyAtUtc,
      `tenant state.tenants[${index}].lastNonEmptyAtUtc`,
    ),
    lastNonEmptyCount: nullableNonNegativeInteger(
      item.lastNonEmptyCount,
      `tenant state.tenants[${index}].lastNonEmptyCount`,
    ),
    recentSuccessfulCounts: (() => {
      const values = item.recentSuccessfulCounts ?? [];
      if (!Array.isArray(values) || values.length > 32) {
        throw new Error(
          `tenant state.tenants[${index}].recentSuccessfulCounts must be an array of at most 32 integers`,
        );
      }
      return values.map((value, valueIndex) => nonNegativeInteger(
        value,
        `tenant state.tenants[${index}].recentSuccessfulCounts[${valueIndex}]`,
      ));
    })(),
    lastListingOutcome: item.lastListingOutcome == null
      ? null
      : requireString(
        item.lastListingOutcome,
        `tenant state.tenants[${index}].lastListingOutcome`,
      ),
    health,
    cooldownUntilUtc: validDateString(
      item.cooldownUntilUtc,
      `tenant state.tenants[${index}].cooldownUntilUtc`,
    ),
    nextEligibleScanAtUtc: validDateString(
      item.nextEligibleScanAtUtc,
      `tenant state.tenants[${index}].nextEligibleScanAtUtc`,
    ),
    lastErrorClass: item.lastErrorClass == null
      ? null
      : requireString(
        item.lastErrorClass,
        `tenant state.tenants[${index}].lastErrorClass`,
      ),
    lastHttpStatus: nullableNonNegativeInteger(
      item.lastHttpStatus,
      `tenant state.tenants[${index}].lastHttpStatus`,
    ),
  };
}
export function validateTenantStateEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tenant state must be an object');
  }
  if (value.schemaVersion !== 1) {
    throw new Error('tenant state.schemaVersion must be 1');
  }
  const updatedAtUtc = validDateString(
    value.updatedAtUtc,
    'tenant state.updatedAtUtc',
    { nullable: false },
  );
  if (!Array.isArray(value.providers)) {
    throw new Error('tenant state.providers must be an array');
  }
  if (!Array.isArray(value.tenants)) {
    throw new Error('tenant state.tenants must be an array');
  }
  const providers = value.providers.map(validateProviderState);
  const tenants = value.tenants.map(validateTenantEntry);
  const providerKeys = new Set();
  for (const provider of providers) {
    const key = provider.healthPartition;
    if (providerKeys.has(key)) throw new Error(`Duplicate provider state: ${key}`);
    providerKeys.add(key);
  }
  const tenantKeys = new Set();
  for (const tenant of tenants) {
    const key = tenantStateKey(tenant.provider, tenant.tenant, tenant.providerVariant);
    if (tenantKeys.has(key)) throw new Error(`Duplicate tenant state: ${key}`);
    tenantKeys.add(key);
  }
  providers.sort((left, right) => left.healthPartition.localeCompare(right.healthPartition));
  tenants.sort((left, right) => {
    const partition = left.healthPartition.localeCompare(right.healthPartition);
    return partition !== 0 ? partition : left.tenant.localeCompare(right.tenant);
  });

  return {
    schemaVersion: 1,
    updatedAtUtc,
    providers,
    tenants,
  };
}
export async function loadTenantState(filePath, { now = new Date() } = {}) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return createEmptyTenantState(now);
    throw new Error(`Tenant state is not readable: ${filePath}`, { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Tenant state is not valid JSON: ${filePath}`, { cause: error });
  }
  return validateTenantStateEnvelope(parsed);
}

export async function saveTenantState(filePath, state) {
  const validated = validateTenantStateEnvelope(state);
  await writeJsonAtomic(filePath, validated);
  return validated;
}
export function tenantStateMaps(state) {
  const validated = validateTenantStateEnvelope(state);
  return {
    providers: new Map(
      validated.providers.map((item) => [item.healthPartition, item]),
    ),
    tenants: new Map(
      validated.tenants.map((item) => [
        tenantStateKey(item.provider, item.tenant, item.providerVariant),
        item,
      ]),
    ),
  };
}
export function isDurableTenantFailure(result) {
  return isDurableProviderResult(result);
}

function isRecent(dateString, now, windowHours) {
  if (!dateString) return false;
  return Date.parse(dateString) >= now.getTime() - windowHours * 3_600_000;
}
function median(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}
function transitionTenant(previous, target, result, providerPolicy, finishedAt) {
  const base = previous ?? {
    provider: target.provider,
    providerVariant: target.providerVariant ?? null,
    healthPartition: target.healthPartition ?? providerHealthPartition(
      target.provider,
      target.providerVariant,
    ),
    tenant: target.tenant,
    firstSeenAtUtc: finishedAt.toISOString(),
    lastAttemptAtUtc: null,
    lastSuccessfulAtUtc: null,
    lastRelevantCandidateAtUtc: null,
    lastJobsReturned: null,
    lastCandidatesMatched: null,
    lastCandidatesRetained: null,
    lastDurationMs: null,
    consecutiveFailures: 0,
    consecutiveDurableFailures: 0,
    consecutiveTransientFailures: 0,
    consecutiveEmptySuccesses: 0,
    consecutiveSuspiciousEmptyResults: 0,
    lastNonEmptyAtUtc: null,
    lastNonEmptyCount: null,
    recentSuccessfulCounts: [],
    lastListingOutcome: null,
    health: 'healthy',
    cooldownUntilUtc: null,
    nextEligibleScanAtUtc: null,
    lastErrorClass: null,
    lastHttpStatus: null,
  };
  if (result.status === 'skipped') return base;
  const scheduling = providerPolicy.scheduling;
  const next = {
    ...base,
    provider: String(target.provider).toLowerCase(),
    providerVariant: target.providerVariant ?? null,
    healthPartition: target.healthPartition ?? providerHealthPartition(
      target.provider,
      target.providerVariant,
    ),
    tenant: target.tenant,
    lastAttemptAtUtc: finishedAt.toISOString(),
    lastDurationMs: result.durationMs,
    lastJobsReturned: result.jobsReturned,
    lastCandidatesMatched: result.candidatesMatched ?? result.candidatesRetained ?? 0,
    lastCandidatesRetained: result.candidatesRetained,
    lastErrorClass: result.errorClass,
    lastHttpStatus: result.httpStatus,
    lastListingOutcome: result.listingOutcome ?? null,
  };
  if (result.status === 'ok') {
    const monitoring = providerPolicy.monitoring;
    const baseline = median(base.recentSuccessfulCounts);
    const baselineEstablished =
      baseline >= monitoring.suspiciousEmptyBaselineMinimumJobs;
    const zeroListing = result.jobsReturned === 0;
    const suspiciousEmptyOutcome = baselineEstablished && zeroListing
      ? 'listing_empty_anomaly'
      : null;
    const confirmedEmptyResult = suspiciousEmptyOutcome != null
      && base.consecutiveSuspiciousEmptyResults >= 1;
    if (suspiciousEmptyOutcome && !confirmedEmptyResult) {
      next.health = 'temporarily_failed';
      next.consecutiveSuspiciousEmptyResults = 1;
      next.lastListingOutcome = suspiciousEmptyOutcome;
      next.nextEligibleScanAtUtc = addMinutes(
        finishedAt,
        monitoring.suspiciousEmptyReprobeMinutes,
      );
      return next;
    }
    next.lastSuccessfulAtUtc = finishedAt.toISOString();
    next.consecutiveFailures = 0;
    next.consecutiveDurableFailures = 0;
    next.consecutiveTransientFailures = 0;
    next.consecutiveSuspiciousEmptyResults = 0;
    next.cooldownUntilUtc = null;
    next.lastErrorClass = null;
    next.lastHttpStatus = null;

    if ((result.candidatesMatched ?? result.candidatesRetained ?? 0) > 0) {
      next.lastRelevantCandidateAtUtc = finishedAt.toISOString();
    }
    if (result.jobsReturned === 0) {
      next.consecutiveEmptySuccesses = base.consecutiveEmptySuccesses + 1;
      if (confirmedEmptyResult) next.recentSuccessfulCounts = [0];
    } else {
      next.consecutiveEmptySuccesses = 0;
      next.lastNonEmptyAtUtc = finishedAt.toISOString();
      next.lastNonEmptyCount = result.jobsReturned;
      next.recentSuccessfulCounts = [
        ...base.recentSuccessfulCounts,
        result.jobsReturned,
      ].slice(-providerPolicy.monitoring.recentSuccessfulCountWindow);
    }
    const recent = isRecent(
      next.lastRelevantCandidateAtUtc,
      finishedAt,
      scheduling.recentActivityWindowHours,
    );
    let intervalHours;
    if (target.healthOnly && target.canary?.intervalHours) {
      next.health = 'healthy';
      intervalHours = target.canary.intervalHours;
    } else if (target.targetClass === 'priority') {
      next.health = recent ? 'active' : 'healthy';
      intervalHours = target.canary?.intervalHours
        ? Math.min(scheduling.priorityIntervalHours, target.canary.intervalHours)
        : scheduling.priorityIntervalHours;
    } else if (
      next.consecutiveEmptySuccesses >= scheduling.longEmptyAfterEmptyScans
    ) {
      next.health = 'long_empty';
      intervalHours = scheduling.longEmptyIntervalHours;
    } else if (recent) {
      next.health = 'active';
      intervalHours = scheduling.activeIntervalHours;
    } else {
      next.health = 'healthy';
      intervalHours = scheduling.healthyIntervalHours;
    }
    next.nextEligibleScanAtUtc = addHours(finishedAt, intervalHours);
    return next;
  }

  next.consecutiveFailures = base.consecutiveFailures + 1;
  next.consecutiveEmptySuccesses = base.consecutiveEmptySuccesses;
  if (
    result.errorClass === 'provider_anomaly'
    && ['listing_empty_anomaly', 'listing_volume_anomaly'].includes(
      result.listingOutcome,
    )
  ) {
    next.health = 'temporarily_failed';
    next.consecutiveSuspiciousEmptyResults =
      base.consecutiveSuspiciousEmptyResults + 1;
    next.cooldownUntilUtc = null;
    next.nextEligibleScanAtUtc = addMinutes(
      finishedAt,
      providerPolicy.monitoring.suspiciousEmptyReprobeMinutes,
    );
    return next;
  }
  if (isDurableTenantFailure(result)) {
    next.consecutiveDurableFailures = base.consecutiveDurableFailures + 1;
    next.consecutiveTransientFailures = 0;
    next.consecutiveSuspiciousEmptyResults = 0;
    next.cooldownUntilUtc = null;
    if (
      next.consecutiveDurableFailures >= scheduling.confirmedDeadAfterFailures
    ) {
      next.health = 'confirmed_dead';
      next.nextEligibleScanAtUtc = addHours(
        finishedAt,
        scheduling.deadReprobeIntervalHours,
      );
    } else if (
      next.consecutiveDurableFailures >= scheduling.suspectedDeadAfterFailures
    ) {
      next.health = 'suspected_dead';
      next.nextEligibleScanAtUtc = addHours(
        finishedAt,
        scheduling.deadReprobeIntervalHours,
      );
    } else {
      next.health = 'temporarily_failed';
      next.nextEligibleScanAtUtc = addHours(
        finishedAt,
        scheduling.firstDurableFailureRetryHours,
      );
    }
    return next;
  }
  next.consecutiveDurableFailures = 0;
  next.consecutiveTransientFailures = base.consecutiveTransientFailures + 1;
  const cooldownMinutes = result.errorClass === 'rate_limited'
    ? scheduling.rateLimitCooldownMinutes
    : scheduling.transientFailureCooldownMinutes;
  next.health = result.errorClass === 'rate_limited'
    ? 'cooldown'
    : 'temporarily_failed';
  next.cooldownUntilUtc = addMinutes(finishedAt, cooldownMinutes);
  next.nextEligibleScanAtUtc = next.cooldownUntilUtc;
  return next;
}
function providerTransition(previous, observation, breakerEvent, policy, finishedAt) {
  const provider = observation?.provider ?? breakerEvent?.provider ?? previous?.provider;
  const providerVariant = observation?.providerVariant
    ?? breakerEvent?.providerVariant
    ?? previous?.providerVariant
    ?? null;
  const healthPartition = observation?.healthPartition
    ?? breakerEvent?.healthPartition
    ?? previous?.healthPartition
    ?? providerHealthPartition(provider, providerVariant);
  const base = previous ?? {
    provider,
    providerVariant,
    healthPartition,
    health: 'healthy',
    cooldownUntilUtc: null,
    lastBreakerAtUtc: null,
    lastBreakerReason: null,
    lastRunAtUtc: null,
    lastRequestsAttempted: null,
    lastRateLimited: null,
  };
  const next = {
    ...base,
    provider,
    providerVariant,
    healthPartition,
  };
  if (observation) {
    next.lastRunAtUtc = finishedAt.toISOString();
    next.lastRequestsAttempted = observation.requestsAttempted;
    next.lastRateLimited = observation.rateLimited;
  }
  if (breakerEvent) {
    next.health = 'cooldown';
    next.cooldownUntilUtc = addMinutes(
      finishedAt,
      policy.execution.breaker.cooldownMinutes,
    );
    next.lastBreakerAtUtc = finishedAt.toISOString();
    next.lastBreakerReason = breakerEvent.reason;
  } else if (
    next.cooldownUntilUtc == null
    || Date.parse(next.cooldownUntilUtc) <= finishedAt.getTime()
  ) {
    next.health = 'healthy';
    next.cooldownUntilUtc = null;
  }
  return next;
}
function compactChange(previous, next) {
  return {
    provider: next.provider,
    providerVariant: next.providerVariant ?? null,
    healthPartition: next.healthPartition,
    tenant: next.tenant,
    previousHealth: previous?.health ?? null,
    health: next.health,
    previousNextEligibleScanAtUtc: previous?.nextEligibleScanAtUtc ?? null,
    nextEligibleScanAtUtc: next.nextEligibleScanAtUtc,
    consecutiveFailures: next.consecutiveFailures,
    consecutiveDurableFailures: next.consecutiveDurableFailures,
    consecutiveTransientFailures: next.consecutiveTransientFailures,
    consecutiveEmptySuccesses: next.consecutiveEmptySuccesses,
    consecutiveSuspiciousEmptyResults: next.consecutiveSuspiciousEmptyResults,
    listingOutcome: next.lastListingOutcome,
    lastNonEmptyCount: next.lastNonEmptyCount,
    lastErrorClass: next.lastErrorClass,
    lastHttpStatus: next.lastHttpStatus,
  };
}
export function buildNextTenantState({
  previousState,
  targets,
  providerResults,
  rateObservations,
  breakerEvents = [],
  policy,
  finishedAt = new Date(),
}) {
  const now = finishedAt instanceof Date ? finishedAt : new Date(finishedAt);
  if (Number.isNaN(now.getTime())) throw new Error('finishedAt must be a valid date');
  if (!Array.isArray(targets) || !Array.isArray(providerResults)) {
    throw new Error('targets and providerResults must be arrays');
  }
  const previous = tenantStateMaps(previousState);
  const targetBySequence = new Map(targets.map((target) => [target.sequence, target]));
  const nextTenants = new Map(previous.tenants);
  const changes = [];
  for (const result of providerResults) {
    if (result.status === 'skipped') continue;
    const target = targetBySequence.get(result.sequence);
    if (!target) throw new Error(`Provider result has no target: sequence ${result.sequence}`);
    const key = tenantStateKey(
      target.provider,
      target.tenant,
      target.providerVariant,
    );
    const legacyKey = target.providerVariant == null
      ? null
      : tenantStateKey(target.provider, target.tenant, null);
    const before = previous.tenants.get(key)
      ?? (legacyKey == null ? null : previous.tenants.get(legacyKey))
      ?? null;
    if (legacyKey != null && legacyKey !== key) nextTenants.delete(legacyKey);
    const after = transitionTenant(
      before,
      target,
      result,
      getProviderPolicy(policy, target.provider),
      now,
    );
    nextTenants.set(key, after);
    changes.push(compactChange(before, after));
  }
  const observationByProvider = new Map(
    (rateObservations?.providers ?? []).map((item) => [
      item.healthPartition ?? providerHealthPartition(item.provider, item.providerVariant),
      item,
    ]),
  );
  const breakerByProvider = new Map(
    breakerEvents.map((item) => [
      item.healthPartition ?? providerHealthPartition(item.provider, item.providerVariant),
      item,
    ]),
  );
  const variantFamiliesObserved = new Set([
    ...(rateObservations?.providers ?? []),
    ...breakerEvents,
  ].filter((item) => item.providerVariant != null).map((item) => item.provider));
  const retainedPreviousProviderKeys = [...previous.providers.entries()]
    .filter(([, item]) => (
      item.providerVariant != null
      || !variantFamiliesObserved.has(item.provider)
    ))
    .map(([key]) => key);
  const providerIds = new Set([
    ...retainedPreviousProviderKeys,
    ...observationByProvider.keys(),
    ...breakerByProvider.keys(),
  ]);
  const nextProviders = [];
  const providerChanges = [];
  for (const healthPartition of [...providerIds].sort()) {
    const before = previous.providers.get(healthPartition) ?? null;
    const observation = observationByProvider.get(healthPartition) ?? null;
    const breakerEvent = breakerByProvider.get(healthPartition) ?? null;
    const providerId = observation?.provider ?? breakerEvent?.provider ?? before?.provider;
    const after = providerTransition(
      before,
      observation,
      breakerEvent,
      getProviderPolicy(policy, providerId),
      now,
    );
    nextProviders.push(after);
    if (
      before?.health !== after.health
      || before?.cooldownUntilUtc !== after.cooldownUntilUtc
      || breakerByProvider.has(healthPartition)
    ) {
      providerChanges.push({
        provider: after.provider,
        providerVariant: after.providerVariant,
        healthPartition: after.healthPartition,
        previousHealth: before?.health ?? null,
        health: after.health,
        cooldownUntilUtc: after.cooldownUntilUtc,
        breakerReason: after.lastBreakerReason,
      });
    }
  }
  const nextState = validateTenantStateEnvelope({
    schemaVersion: 1,
    updatedAtUtc: now.toISOString(),
    providers: nextProviders,
    tenants: [...nextTenants.values()],
  });

  return {
    state: nextState,
    changes: {
      schemaVersion: 1,
      generatedAtUtc: now.toISOString(),
      tenantChanges: changes,
      providerChanges,
    },
  };
}
