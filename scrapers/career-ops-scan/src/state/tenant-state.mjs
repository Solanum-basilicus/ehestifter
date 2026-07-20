import { readFile } from 'node:fs/promises';

import { writeJsonAtomic } from '../io/atomic-json.mjs';
import { getProviderPolicy } from '../policy/discovery-policy.mjs';

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

export function tenantStateKey(provider, tenant) {
  return `${String(provider).toLowerCase()}::${String(tenant).toLowerCase()}`;
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
  return {
    provider: requireString(item.provider, `tenant state.providers[${index}].provider`),
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
  );
  const tenant = requireString(
    item.tenant,
    `tenant state.tenants[${index}].tenant`,
  );

  return {
    provider,
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
    const key = provider.provider.toLowerCase();
    if (providerKeys.has(key)) throw new Error(`Duplicate provider state: ${provider.provider}`);
    providerKeys.add(key);
  }
  const tenantKeys = new Set();
  for (const tenant of tenants) {
    const key = tenantStateKey(tenant.provider, tenant.tenant);
    if (tenantKeys.has(key)) throw new Error(`Duplicate tenant state: ${key}`);
    tenantKeys.add(key);
  }

  providers.sort((left, right) => left.provider.localeCompare(right.provider));
  tenants.sort((left, right) => {
    const provider = left.provider.localeCompare(right.provider);
    return provider !== 0 ? provider : left.tenant.localeCompare(right.tenant);
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
      validated.providers.map((item) => [item.provider.toLowerCase(), item]),
    ),
    tenants: new Map(
      validated.tenants.map((item) => [tenantStateKey(item.provider, item.tenant), item]),
    ),
  };
}

export function isDurableTenantFailure(result) {
  return result?.errorClass === 'http_4xx'
    && [404, 410].includes(result.httpStatus);
}

function isRecent(dateString, now, windowHours) {
  if (!dateString) return false;
  return Date.parse(dateString) >= now.getTime() - windowHours * 3_600_000;
}

function transitionTenant(previous, target, result, providerPolicy, finishedAt) {
  const base = previous ?? {
    provider: target.provider,
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
    lastAttemptAtUtc: finishedAt.toISOString(),
    lastDurationMs: result.durationMs,
    lastJobsReturned: result.jobsReturned,
    lastCandidatesMatched: result.candidatesMatched ?? result.candidatesRetained ?? 0,
    lastCandidatesRetained: result.candidatesRetained,
    lastErrorClass: result.errorClass,
    lastHttpStatus: result.httpStatus,
  };

  if (result.status === 'ok') {
    next.lastSuccessfulAtUtc = finishedAt.toISOString();
    next.consecutiveFailures = 0;
    next.consecutiveDurableFailures = 0;
    next.consecutiveTransientFailures = 0;
    next.cooldownUntilUtc = null;
    next.lastErrorClass = null;
    next.lastHttpStatus = null;

    if ((result.candidatesMatched ?? result.candidatesRetained ?? 0) > 0) {
      next.lastRelevantCandidateAtUtc = finishedAt.toISOString();
    }

    if (result.jobsReturned === 0) {
      next.consecutiveEmptySuccesses = base.consecutiveEmptySuccesses + 1;
    } else {
      next.consecutiveEmptySuccesses = 0;
    }

    const recent = isRecent(
      next.lastRelevantCandidateAtUtc,
      finishedAt,
      scheduling.recentActivityWindowHours,
    );

    let intervalHours;
    if (target.targetClass === 'priority') {
      next.health = recent ? 'active' : 'healthy';
      intervalHours = scheduling.priorityIntervalHours;
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

  if (isDurableTenantFailure(result)) {
    next.consecutiveDurableFailures = base.consecutiveDurableFailures + 1;
    next.consecutiveTransientFailures = 0;
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

function providerTransition(previous, providerId, observation, breakerEvent, policy, finishedAt) {
  const base = previous ?? {
    provider: providerId,
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
    provider: providerId,
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
    tenant: next.tenant,
    previousHealth: previous?.health ?? null,
    health: next.health,
    previousNextEligibleScanAtUtc: previous?.nextEligibleScanAtUtc ?? null,
    nextEligibleScanAtUtc: next.nextEligibleScanAtUtc,
    consecutiveFailures: next.consecutiveFailures,
    consecutiveDurableFailures: next.consecutiveDurableFailures,
    consecutiveTransientFailures: next.consecutiveTransientFailures,
    consecutiveEmptySuccesses: next.consecutiveEmptySuccesses,
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
    const key = tenantStateKey(target.provider, target.tenant);
    const before = previous.tenants.get(key) ?? null;
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
    (rateObservations?.providers ?? []).map((item) => [item.provider, item]),
  );
  const breakerByProvider = new Map(
    breakerEvents.map((item) => [item.provider, item]),
  );
  const providerIds = new Set([
    ...previous.providers.keys(),
    ...observationByProvider.keys(),
    ...breakerByProvider.keys(),
  ]);
  const nextProviders = [];
  const providerChanges = [];
  for (const providerId of [...providerIds].sort()) {
    const before = previous.providers.get(providerId) ?? null;
    const after = providerTransition(
      before,
      providerId,
      observationByProvider.get(providerId),
      breakerByProvider.get(providerId),
      getProviderPolicy(policy, providerId),
      now,
    );
    nextProviders.push(after);
    if (
      before?.health !== after.health
      || before?.cooldownUntilUtc !== after.cooldownUntilUtc
      || breakerByProvider.has(providerId)
    ) {
      providerChanges.push({
        provider: providerId,
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
