import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getProviderPolicy,
  parseDiscoveryPolicy,
  PHASE3_MAX_NORMAL_TARGETS_PER_RUN,
} from '../src/policy/discovery-policy.mjs';

function raw(overrides = {}) {
  return {
    schema_version: 1,
    providers: {
      ashby: {
        catalog_enabled: true,
        max_normal_targets_per_run: 100,
        target_full_sweep_days: 3,
      },
    },
    ...overrides,
  };
}

test('policy applies conservative Phase 3 defaults', () => {
  const policy = parseDiscoveryPolicy(raw());
  const ashby = getProviderPolicy(policy, 'ashby');
  assert.equal(ashby.scheduling.priorityIntervalHours, 24);
  assert.equal(ashby.scheduling.healthyIntervalHours, 72);
  assert.equal(ashby.lookback.overlapHours, 12);
  assert.equal(ashby.execution.concurrency, 3);
  assert.equal(ashby.execution.minRequestIntervalMs, 150);
  assert.equal(ashby.maxNormalTargetsPerRun, 100);
  assert.equal(ashby.targetFullSweepDays, 3);
});

test('provider values override defaults without discarding siblings', () => {
  const policy = parseDiscoveryPolicy(raw({
    defaults: {
      scheduling: { healthy_interval_hours: 96 },
      execution: { concurrency: 4 },
    },
    providers: {
      ashby: {
        catalog_enabled: true,
        max_normal_targets_per_run: 700,
        target_full_sweep_days: 3,
        execution: { min_request_interval_ms: 250 },
      },
    },
  }));
  const ashby = getProviderPolicy(policy, 'ashby');
  assert.equal(ashby.scheduling.healthyIntervalHours, 96);
  assert.equal(ashby.execution.concurrency, 4);
  assert.equal(ashby.execution.minRequestIntervalMs, 250);
  assert.equal(ashby.maxNormalTargetsPerRun, 700);
});

test('unknown providers inherit defaults and cannot scan catalogs', () => {
  const policy = parseDiscoveryPolicy(raw());
  const lever = getProviderPolicy(policy, 'lever');
  assert.equal(lever.catalogEnabled, false);
  assert.equal(lever.maxNormalTargetsPerRun, 0);
  assert.equal(lever.execution.concurrency, 3);
});

test('Phase 3 retains a hard normal-target ceiling', () => {
  assert.equal(PHASE3_MAX_NORMAL_TARGETS_PER_RUN, 2000);
  assert.throws(
    () => parseDiscoveryPolicy(raw({
      providers: {
        ashby: {
          max_normal_targets_per_run: 2001,
          target_full_sweep_days: 3,
        },
      },
    })),
    /must be an integer from 1 to 2000/,
  );
});

test('confirmed-dead threshold must exceed suspected-dead threshold', () => {
  assert.throws(
    () => parseDiscoveryPolicy(raw({
      defaults: {
        scheduling: {
          suspected_dead_after_failures: 4,
          confirmed_dead_after_failures: 4,
        },
      },
      providers: { ashby: {} },
    })),
    /must be greater than/,
  );
});

test('initial lookback cannot exceed maximum lookback', () => {
  assert.throws(
    () => parseDiscoveryPolicy(raw({
      defaults: { lookback: { initial_hours: 300, max_hours: 240 } },
      providers: { ashby: {} },
    })),
    /initial_hours cannot exceed/,
  );
});

test('breaker ratio is constrained to a valid probability', () => {
  assert.throws(
    () => parseDiscoveryPolicy(raw({
      defaults: {
        execution: { breaker: { transient_error_ratio_threshold: 1.1 } },
      },
      providers: { ashby: {} },
    })),
    /must be a number from 0.01 to 1/,
  );
});

test('policy requires schema version one and Ashby provider', () => {
  assert.throws(() => parseDiscoveryPolicy({ schema_version: 2, providers: {} }), /schema_version/);
  assert.throws(() => parseDiscoveryPolicy({ schema_version: 1, providers: {} }), /providers.ashby/);
});

test('catalog and dead-reprobe flags are strict booleans', () => {
  assert.throws(
    () => parseDiscoveryPolicy(raw({ providers: { ashby: { catalog_enabled: 'yes' } } })),
    /catalog_enabled must be boolean/,
  );
  assert.throws(
    () => parseDiscoveryPolicy(raw({
      defaults: { lookback: { dead_reprobe_unbounded: 'yes' } },
      providers: { ashby: {} },
    })),
    /dead_reprobe_unbounded must be boolean/,
  );
});

test('operator recommendation limits are validated', () => {
  assert.throws(
    () => parseDiscoveryPolicy(raw({
      defaults: { recommendations: { healthy_success_ratio: 0.2 } },
      providers: { ashby: {} },
    })),
    /healthy_success_ratio/,
  );
});

test('monitoring defaults protect historically active providers from silent empty results', () => {
  const parsed = parseDiscoveryPolicy(raw());
  const ashby = getProviderPolicy(parsed, 'ashby');
  assert.deepEqual(ashby.monitoring, {
    suspiciousEmptyBaselineMinimumJobs: 10,
    suspiciousEmptyReprobeMinutes: 60,
    suspiciousVolumeDropRatio: 0.9,
    recentSuccessfulCountWindow: 8,
    degradedMinimumAttempts: 2,
    degradedErrorRatio: 0.5,
  });
});

test('provider monitoring overrides are validated and preserve default siblings', () => {
  const parsed = parseDiscoveryPolicy(raw({
    providers: {
      ashby: {
        catalog_enabled: true,
        max_normal_targets_per_run: 100,
        target_full_sweep_days: 3,
      },
      successfactors: {
        monitoring: {
          suspicious_empty_reprobe_minutes: 30,
          suspicious_volume_drop_ratio: 0.8,
          degraded_error_ratio: 0.25,
        },
      },
    },
  }));
  const successfactors = getProviderPolicy(parsed, 'successfactors');
  assert.equal(successfactors.monitoring.suspiciousEmptyReprobeMinutes, 30);
  assert.equal(successfactors.monitoring.degradedErrorRatio, 0.25);
  assert.equal(successfactors.monitoring.suspiciousVolumeDropRatio, 0.8);
  assert.equal(successfactors.monitoring.recentSuccessfulCountWindow, 8);
  assert.throws(
    () => parseDiscoveryPolicy(raw({
      defaults: { monitoring: { recent_successful_count_window: 1 } },
      providers: { ashby: {} },
    })),
    /recent_successful_count_window/,
  );
});
