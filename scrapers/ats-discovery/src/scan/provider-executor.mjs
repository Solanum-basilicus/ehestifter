import { performance } from 'node:perf_hooks';

import { getProviderPolicy } from '../policy/discovery-policy.mjs';
import { targetHealthIdentity } from '../providers/_variant.mjs';
import {
  classifyProviderError,
  isDurableProviderResult,
  isTransientProviderResult,
  providerErrorMessage,
  providerHttpStatus,
} from './provider-errors.mjs';

// Maintenance targets are intentionally expected to contain stale or
// inaccessible tenants. Tenant-local 4xx responses must not consume the
// provider-wide breaker sample. 408 and 429 remain provider-health signals.
const MAINTENANCE_BUCKETS = new Set([
  'recovery',
  'dead_reprobe',
  'long_empty',
]);
function isCircuitEligibleResult(target, result) {
  if (isDurableProviderResult(result)) return false;
  if (!MAINTENANCE_BUCKETS.has(target?.scheduleBucket)) return true;
  if (result?.status !== 'error') return true;
  const status = result.httpStatus;
  if (!Number.isInteger(status) || status < 400 || status >= 500) return true;
  return [408, 429].includes(status);
}

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }
  async acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  release() {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}
function cleanTelemetry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return {
    acquisitionMode: typeof value.acquisitionMode === 'string'
      ? value.acquisitionMode.slice(0, 100)
      : null,
    listingOutcome: typeof value.listingOutcome === 'string'
      ? value.listingOutcome.slice(0, 100)
      : null,
    explicitTotal: Number.isInteger(value.explicitTotal) && value.explicitTotal >= 0
      ? value.explicitTotal
      : null,
  };
}
function normalizedFetchValue(value) {
  if (Array.isArray(value)) return { jobs: value, telemetry: {} };
  if (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Array.isArray(value.jobs)
    && Object.hasOwn(value, 'providerTelemetry')
  ) {
    return {
      jobs: value.jobs,
      telemetry: cleanTelemetry(value.providerTelemetry),
    };
  }
  const error = new Error('Provider returned a non-array job list');
  error.code = 'INVALID_PROVIDER_RESULT';
  throw error;
}
function resultIdentity(target) {
  const identity = target.healthPartition
    ? {
      provider: target.provider,
      providerVariant: target.providerVariant ?? null,
      healthPartition: target.healthPartition,
    }
    : targetHealthIdentity(target);
  return identity;
}
function baseProviderResult(target) {
  const identity = resultIdentity(target);
  return {
    sequence: target.sequence,
    provider: identity.provider,
    providerVariant: identity.providerVariant,
    healthPartition: identity.healthPartition,
    tenant: target.tenant,
    targetClass: target.targetClass,
    healthOnly: target.healthOnly === true,
  };
}
class ProviderGuard {
  constructor({ identity, policy, monotonicNow, sleep }) {
    this.identity = identity;
    this.policy = policy;
    this.monotonicNow = monotonicNow;
    this.sleep = sleep;
    this.semaphore = new Semaphore(policy.execution.concurrency);
    this.pacingChain = Promise.resolve();
    this.nextStartAtMs = Number.NEGATIVE_INFINITY;
    this.open = false;
    this.breakerEvent = null;
    this.requestsAttempted = 0;
    this.rateLimited = 0;
    this.transientErrors = 0;
  }
  async pace() {
    let release;
    const previous = this.pacingChain;
    this.pacingChain = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.open) return false;
      const now = this.monotonicNow();
      const waitMs = Math.max(0, this.nextStartAtMs - now);
      if (waitMs > 0) await this.sleep(waitMs);
      this.nextStartAtMs = this.monotonicNow()
        + this.policy.execution.minRequestIntervalMs;
      return !this.open;
    } finally {
      release();
    }
  }
  maybeOpen(target, result) {
    if (!isCircuitEligibleResult(target, result)) return;
    this.requestsAttempted += 1;
    if (result.errorClass === 'rate_limited') this.rateLimited += 1;
    if (isTransientProviderResult(result)) this.transientErrors += 1;
    const breaker = this.policy.execution.breaker;
    let reason = null;
    if (this.rateLimited >= breaker.rateLimitThreshold) {
      reason = 'rate_limit_threshold';
    } else if (this.transientErrors >= breaker.transientErrorThreshold) {
      reason = 'transient_error_threshold';
    } else if (
      this.requestsAttempted >= breaker.minimumRequestsForRatio
      && this.transientErrors / this.requestsAttempted
        >= breaker.transientErrorRatioThreshold
    ) {
      reason = 'transient_error_ratio';
    }
    if (reason && !this.open) {
      this.open = true;
      this.breakerEvent = {
        ...this.identity,
        reason,
        requestsAttempted: this.requestsAttempted,
        rateLimited: this.rateLimited,
        transientErrors: this.transientErrors,
      };
    }
  }
  async execute(target, fetchTarget) {
    await this.semaphore.acquire();
    try {
      if (this.open) return skippedResult(target, 'provider_circuit_open');
      const allowed = await this.pace();
      if (!allowed || this.open) {
        return skippedResult(target, 'provider_circuit_open');
      }
      const started = this.monotonicNow();
      let result;
      try {
        const fetched = normalizedFetchValue(await fetchTarget(target));
        const telemetry = cleanTelemetry(fetched.telemetry);
        const inferredOutcome = fetched.jobs.length > 0
          ? 'listing_success_nonempty'
          : 'listing_success_empty_unverified';
        const canaryMinimum = target.canary != null
          ? target.canary.minimumJobs ?? 1
          : null;
        if (canaryMinimum != null && fetched.jobs.length < canaryMinimum) {
          const error = new Error(
            `Provider canary expected at least ${canaryMinimum} jobs, received ${fetched.jobs.length}`,
          );
          error.code = 'PROVIDER_CANARY_MINIMUM_JOBS';
          const anomalyTelemetry = cleanTelemetry({
            ...telemetry,
            listingOutcome: 'listing_volume_anomaly',
          });
          result = {
            target,
            jobs: fetched.jobs,
            error,
            providerResult: {
              ...baseProviderResult(target),
              status: 'error',
              skipReason: null,
              errorClass: classifyProviderError(error),
              errorMessage: providerErrorMessage(error),
              httpStatus: null,
              jobsReturned: fetched.jobs.length,
              candidatesMatched: 0,
              candidatesRetained: 0,
              candidatesDroppedByCap: 0,
              durationMs: Math.max(0, Math.round(this.monotonicNow() - started)),
              acquisitionMode: anomalyTelemetry.acquisitionMode,
              listingOutcome: anomalyTelemetry.listingOutcome,
              explicitTotal: anomalyTelemetry.explicitTotal,
            },
          };
        } else result = {
          target,
          jobs: fetched.jobs,
          error: null,
          providerResult: {
            ...baseProviderResult(target),
            status: 'ok',
            skipReason: null,
            errorClass: null,
            errorMessage: null,
            httpStatus: null,
            jobsReturned: fetched.jobs.length,
            candidatesMatched: 0,
            candidatesRetained: 0,
            candidatesDroppedByCap: 0,
            durationMs: Math.max(0, Math.round(this.monotonicNow() - started)),
            acquisitionMode: telemetry.acquisitionMode,
            listingOutcome: telemetry.listingOutcome ?? inferredOutcome,
            explicitTotal: telemetry.explicitTotal,
          },
        };
      } catch (error) {
        const telemetry = cleanTelemetry(error?.providerTelemetry);
        result = {
          target,
          jobs: [],
          error,
          providerResult: {
            ...baseProviderResult(target),
            status: 'error',
            skipReason: null,
            errorClass: classifyProviderError(error),
            errorMessage: providerErrorMessage(error),
            httpStatus: providerHttpStatus(error),
            jobsReturned: 0,
            candidatesMatched: 0,
            candidatesRetained: 0,
            candidatesDroppedByCap: 0,
            durationMs: Math.max(0, Math.round(this.monotonicNow() - started)),
            acquisitionMode: telemetry.acquisitionMode,
            listingOutcome: telemetry.listingOutcome ?? 'listing_error',
            explicitTotal: telemetry.explicitTotal,
          },
        };
      }
      this.maybeOpen(target, result.providerResult);
      return result;
    } finally {
      this.semaphore.release();
    }
  }
}
function skippedResult(target, reason) {
  return {
    target,
    jobs: [],
    error: null,
    providerResult: {
      ...baseProviderResult(target),
      status: 'skipped',
      skipReason: reason,
      errorClass: null,
      errorMessage: null,
      httpStatus: null,
      jobsReturned: 0,
      candidatesMatched: 0,
      candidatesRetained: 0,
      candidatesDroppedByCap: 0,
      durationMs: 0,
      acquisitionMode: null,
      listingOutcome: 'listing_skipped',
      explicitTotal: null,
    },
  };
}
async function mapLimit(items, limit, worker) {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('global provider concurrency must be a positive integer');
  }
  const results = new Array(items.length);
  let next = 0;
  async function consume() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => consume()),
  );
  return results;
}
export async function executeProviderTargets({
  targets,
  policy,
  globalConcurrency,
  fetchTarget,
  monotonicNow = () => performance.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  onProgress = null,
}) {
  if (!Array.isArray(targets)) throw new Error('targets must be an array');
  if (typeof fetchTarget !== 'function') throw new Error('fetchTarget must be a function');
  if (onProgress != null && typeof onProgress !== 'function') {
    throw new Error('onProgress must be a function');
  }
  let completed = 0;
  function report(result) {
    completed += 1;
    if (!onProgress) return;
    try {
      onProgress({
        stage: 'scan',
        current: completed,
        total: targets.length,
        provider: result.providerResult.provider,
        providerVariant: result.providerResult.providerVariant,
        tenant: result.providerResult.tenant,
        status: result.providerResult.status,
      });
    } catch {
      /* Progress reporting must never alter provider execution. */
    }
  }
  const guards = new Map();
  function guardFor(target) {
    const identity = resultIdentity(target);
    if (!guards.has(identity.healthPartition)) {
      guards.set(identity.healthPartition, new ProviderGuard({
        identity,
        policy: getProviderPolicy(policy, identity.provider),
        monotonicNow,
        sleep,
      }));
    }
    return guards.get(identity.healthPartition);
  }
  async function executeGroup(group) {
    return mapLimit(group, globalConcurrency, async (target) => {
      const result = await guardFor(target).execute(target, fetchTarget);
      report(result);
      return result;
    });
  }
  const priority = targets.filter((target) => target.targetClass === 'priority');
  const normal = targets.filter((target) => target.targetClass !== 'priority');
  const priorityResults = await executeGroup(priority);
  const normalResults = await executeGroup(normal);
  const batches = [...priorityResults, ...normalResults]
    .sort((left, right) => left.target.sequence - right.target.sequence);
  const breakerEvents = [...guards.values()]
    .map((guard) => guard.breakerEvent)
    .filter(Boolean)
    .sort((left, right) => left.healthPartition.localeCompare(right.healthPartition));
  return { batches, breakerEvents };
}
