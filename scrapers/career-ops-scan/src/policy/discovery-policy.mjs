export const PHASE3_MAX_NORMAL_TARGETS_PER_RUN = 2000;

const DEFAULTS = Object.freeze({
  scheduling: Object.freeze({
    priorityIntervalHours: 24,
    activeIntervalHours: 24,
    healthyIntervalHours: 72,
    recentActivityWindowHours: 168,
    longEmptyAfterEmptyScans: 3,
    longEmptyIntervalHours: 168,
    firstDurableFailureRetryHours: 24,
    suspectedDeadAfterFailures: 2,
    confirmedDeadAfterFailures: 4,
    deadReprobeIntervalHours: 720,
    transientFailureCooldownMinutes: 360,
    rateLimitCooldownMinutes: 1440,
  }),
  lookback: Object.freeze({
    initialHours: 72,
    overlapHours: 12,
    maxHours: 240,
    deadReprobeUnbounded: true,
  }),
  execution: Object.freeze({
    concurrency: 3,
    minRequestIntervalMs: 150,
    breaker: Object.freeze({
      rateLimitThreshold: 2,
      transientErrorThreshold: 8,
      transientErrorRatioThreshold: 0.5,
      minimumRequestsForRatio: 10,
      cooldownMinutes: 1440,
    }),
  }),
  recommendations: Object.freeze({
    minimumRequests: 20,
    healthySuccessRatio: 0.98,
    highTransientErrorRatio: 0.2,
    fastP95Ms: 5000,
    maximumSuggestedConcurrency: 8,
  }),
});

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function optionalObject(value, name) {
  if (value == null) return {};
  return requireObject(value, name);
}

function integer(value, fallback, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const result = value == null ? fallback : value;
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return result;
}

function finiteNumber(value, fallback, name, { min = 0, max = Number.MAX_VALUE } = {}) {
  const result = value == null ? fallback : value;
  if (!Number.isFinite(result) || result < min || result > max) {
    throw new Error(`${name} must be a number from ${min} to ${max}`);
  }
  return result;
}

function booleanValue(value, fallback, name) {
  const result = value == null ? fallback : value;
  if (typeof result !== 'boolean') {
    throw new Error(`${name} must be boolean`);
  }
  return result;
}

function parseScheduling(raw, base, name) {
  const value = optionalObject(raw, name);
  const result = {
    priorityIntervalHours: finiteNumber(
      value.priority_interval_hours,
      base.priorityIntervalHours,
      `${name}.priority_interval_hours`,
      { min: 1, max: 24 * 30 },
    ),
    activeIntervalHours: finiteNumber(
      value.active_interval_hours,
      base.activeIntervalHours,
      `${name}.active_interval_hours`,
      { min: 1, max: 24 * 30 },
    ),
    healthyIntervalHours: finiteNumber(
      value.healthy_interval_hours,
      base.healthyIntervalHours,
      `${name}.healthy_interval_hours`,
      { min: 1, max: 24 * 30 },
    ),
    recentActivityWindowHours: finiteNumber(
      value.recent_activity_window_hours,
      base.recentActivityWindowHours,
      `${name}.recent_activity_window_hours`,
      { min: 1, max: 24 * 365 },
    ),
    longEmptyAfterEmptyScans: integer(
      value.long_empty_after_empty_scans,
      base.longEmptyAfterEmptyScans,
      `${name}.long_empty_after_empty_scans`,
      { min: 1, max: 100 },
    ),
    longEmptyIntervalHours: finiteNumber(
      value.long_empty_interval_hours,
      base.longEmptyIntervalHours,
      `${name}.long_empty_interval_hours`,
      { min: 1, max: 24 * 365 },
    ),
    firstDurableFailureRetryHours: finiteNumber(
      value.first_durable_failure_retry_hours,
      base.firstDurableFailureRetryHours,
      `${name}.first_durable_failure_retry_hours`,
      { min: 1, max: 24 * 365 },
    ),
    suspectedDeadAfterFailures: integer(
      value.suspected_dead_after_failures,
      base.suspectedDeadAfterFailures,
      `${name}.suspected_dead_after_failures`,
      { min: 1, max: 100 },
    ),
    confirmedDeadAfterFailures: integer(
      value.confirmed_dead_after_failures,
      base.confirmedDeadAfterFailures,
      `${name}.confirmed_dead_after_failures`,
      { min: 2, max: 100 },
    ),
    deadReprobeIntervalHours: finiteNumber(
      value.dead_reprobe_interval_hours,
      base.deadReprobeIntervalHours,
      `${name}.dead_reprobe_interval_hours`,
      { min: 1, max: 24 * 365 },
    ),
    transientFailureCooldownMinutes: finiteNumber(
      value.transient_failure_cooldown_minutes,
      base.transientFailureCooldownMinutes,
      `${name}.transient_failure_cooldown_minutes`,
      { min: 1, max: 60 * 24 * 30 },
    ),
    rateLimitCooldownMinutes: finiteNumber(
      value.rate_limit_cooldown_minutes,
      base.rateLimitCooldownMinutes,
      `${name}.rate_limit_cooldown_minutes`,
      { min: 1, max: 60 * 24 * 30 },
    ),
  };

  if (result.confirmedDeadAfterFailures <= result.suspectedDeadAfterFailures) {
    throw new Error(
      `${name}.confirmed_dead_after_failures must be greater than `
      + `${name}.suspected_dead_after_failures`,
    );
  }
  return result;
}

function parseLookback(raw, base, name) {
  const value = optionalObject(raw, name);
  const result = {
    initialHours: finiteNumber(
      value.initial_hours,
      base.initialHours,
      `${name}.initial_hours`,
      { min: 1, max: 24 * 365 },
    ),
    overlapHours: finiteNumber(
      value.overlap_hours,
      base.overlapHours,
      `${name}.overlap_hours`,
      { min: 0, max: 24 * 30 },
    ),
    maxHours: finiteNumber(
      value.max_hours,
      base.maxHours,
      `${name}.max_hours`,
      { min: 1, max: 24 * 365 },
    ),
    deadReprobeUnbounded: booleanValue(
      value.dead_reprobe_unbounded,
      base.deadReprobeUnbounded,
      `${name}.dead_reprobe_unbounded`,
    ),
  };
  if (result.initialHours > result.maxHours) {
    throw new Error(`${name}.initial_hours cannot exceed ${name}.max_hours`);
  }
  return result;
}

function parseBreaker(raw, base, name) {
  const value = optionalObject(raw, name);
  return {
    rateLimitThreshold: integer(
      value.rate_limit_threshold,
      base.rateLimitThreshold,
      `${name}.rate_limit_threshold`,
      { min: 1, max: 100 },
    ),
    transientErrorThreshold: integer(
      value.transient_error_threshold,
      base.transientErrorThreshold,
      `${name}.transient_error_threshold`,
      { min: 1, max: 1000 },
    ),
    transientErrorRatioThreshold: finiteNumber(
      value.transient_error_ratio_threshold,
      base.transientErrorRatioThreshold,
      `${name}.transient_error_ratio_threshold`,
      { min: 0.01, max: 1 },
    ),
    minimumRequestsForRatio: integer(
      value.minimum_requests_for_ratio,
      base.minimumRequestsForRatio,
      `${name}.minimum_requests_for_ratio`,
      { min: 1, max: 1000 },
    ),
    cooldownMinutes: finiteNumber(
      value.cooldown_minutes,
      base.cooldownMinutes,
      `${name}.cooldown_minutes`,
      { min: 1, max: 60 * 24 * 30 },
    ),
  };
}

function parseExecution(raw, base, name) {
  const value = optionalObject(raw, name);
  return {
    concurrency: integer(
      value.concurrency,
      base.concurrency,
      `${name}.concurrency`,
      { min: 1, max: 64 },
    ),
    minRequestIntervalMs: integer(
      value.min_request_interval_ms,
      base.minRequestIntervalMs,
      `${name}.min_request_interval_ms`,
      { min: 0, max: 60_000 },
    ),
    breaker: parseBreaker(value.breaker, base.breaker, `${name}.breaker`),
  };
}

function parseRecommendations(raw, base, name) {
  const value = optionalObject(raw, name);
  return {
    minimumRequests: integer(
      value.minimum_requests,
      base.minimumRequests,
      `${name}.minimum_requests`,
      { min: 1, max: 10_000 },
    ),
    healthySuccessRatio: finiteNumber(
      value.healthy_success_ratio,
      base.healthySuccessRatio,
      `${name}.healthy_success_ratio`,
      { min: 0.5, max: 1 },
    ),
    highTransientErrorRatio: finiteNumber(
      value.high_transient_error_ratio,
      base.highTransientErrorRatio,
      `${name}.high_transient_error_ratio`,
      { min: 0.01, max: 1 },
    ),
    fastP95Ms: integer(
      value.fast_p95_ms,
      base.fastP95Ms,
      `${name}.fast_p95_ms`,
      { min: 1, max: 600_000 },
    ),
    maximumSuggestedConcurrency: integer(
      value.maximum_suggested_concurrency,
      base.maximumSuggestedConcurrency,
      `${name}.maximum_suggested_concurrency`,
      { min: 1, max: 64 },
    ),
  };
}

function mergeProviderDefaults(defaults, raw, name) {
  const value = optionalObject(raw, name);
  return {
    scheduling: parseScheduling(value.scheduling, defaults.scheduling, `${name}.scheduling`),
    lookback: parseLookback(value.lookback, defaults.lookback, `${name}.lookback`),
    execution: parseExecution(value.execution, defaults.execution, `${name}.execution`),
    recommendations: parseRecommendations(
      value.recommendations,
      defaults.recommendations,
      `${name}.recommendations`,
    ),
  };
}

export function parseDiscoveryPolicy(raw) {
  const root = requireObject(raw, 'discovery policy');
  if (root.schema_version !== 1) {
    throw new Error('discovery policy.schema_version must be 1');
  }

  const rawDefaults = optionalObject(root.defaults, 'discovery policy.defaults');
  const defaults = {
    scheduling: parseScheduling(
      rawDefaults.scheduling,
      DEFAULTS.scheduling,
      'discovery policy.defaults.scheduling',
    ),
    lookback: parseLookback(
      rawDefaults.lookback,
      DEFAULTS.lookback,
      'discovery policy.defaults.lookback',
    ),
    execution: parseExecution(
      rawDefaults.execution,
      DEFAULTS.execution,
      'discovery policy.defaults.execution',
    ),
    recommendations: parseRecommendations(
      rawDefaults.recommendations,
      DEFAULTS.recommendations,
      'discovery policy.defaults.recommendations',
    ),
  };

  const rawProviders = requireObject(root.providers, 'discovery policy.providers');
  const providers = {};
  for (const [providerId, rawProvider] of Object.entries(rawProviders)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(providerId)) {
      throw new Error(`Invalid provider id in discovery policy: ${providerId}`);
    }
    const merged = mergeProviderDefaults(
      defaults,
      rawProvider,
      `discovery policy.providers.${providerId}`,
    );

    if (providerId === 'ashby') {
      const value = optionalObject(rawProvider, 'discovery policy.providers.ashby');
      merged.catalogEnabled = booleanValue(
        value.catalog_enabled,
        true,
        'discovery policy.providers.ashby.catalog_enabled',
      );
      merged.maxNormalTargetsPerRun = integer(
        value.max_normal_targets_per_run,
        100,
        'discovery policy.providers.ashby.max_normal_targets_per_run',
        { min: 1, max: PHASE3_MAX_NORMAL_TARGETS_PER_RUN },
      );
      merged.targetFullSweepDays = integer(
        value.target_full_sweep_days,
        3,
        'discovery policy.providers.ashby.target_full_sweep_days',
        { min: 1, max: 30 },
      );
    }
    providers[providerId] = merged;
  }

  if (!providers.ashby) {
    throw new Error('discovery policy.providers.ashby is required');
  }

  return {
    schemaVersion: 1,
    defaults,
    providers,
  };
}

export function getProviderPolicy(policy, providerId) {
  if (!policy || policy.schemaVersion !== 1) {
    throw new Error('parsed discovery policy is required');
  }
  return policy.providers[providerId] ?? {
    scheduling: policy.defaults.scheduling,
    lookback: policy.defaults.lookback,
    execution: policy.defaults.execution,
    recommendations: policy.defaults.recommendations,
    catalogEnabled: false,
    maxNormalTargetsPerRun: 0,
    targetFullSweepDays: 3,
  };
}
