import { performance } from 'node:perf_hooks';

import { getProviderPolicy } from '../policy/discovery-policy.mjs';
import { targetHealthIdentity } from '../providers/_variant.mjs';
import {
  classifyProviderError,
  isTransientProviderResult,
  providerErrorMessage,
  providerHttpStatus,
  providerNetworkDiagnostic,
} from './provider-errors.mjs';
import { isProviderHealthSignificantResult } from './provider-health.mjs';

const defaultSleep = (milliseconds) => new Promise(
  (resolve) => setTimeout(resolve, milliseconds),
);

async function waitForActiveOrDelay(active, waitMs, sleep) {
  if (sleep !== defaultSleep) {
    await Promise.race([...active, sleep(waitMs)]);
    return;
  }

  let timerId = null;
  const timer = new Promise((resolve) => {
    timerId = setTimeout(resolve, waitMs);
  });
  try {
    await Promise.race([...active, timer]);
  } finally {
    if (timerId != null) clearTimeout(timerId);
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
    scheduleBucket: target.scheduleBucket ?? null,
    healthOnly: target.healthOnly === true,
  };
}
class ProviderGuard {
  constructor({ identity, policy, monotonicNow }) {
    this.identity = identity;
    this.policy = policy;
    this.monotonicNow = monotonicNow;
    this.active = 0;
    this.nextStartAtMs = Number.NEGATIVE_INFINITY;
    this.open = false;
    this.breakerEvent = null;
    this.requestsAttempted = 0;
    this.rateLimited = 0;
    this.transientErrors = 0;
  }
  readyInMs() {
    if (this.open || this.active >= this.policy.execution.concurrency) return Infinity;
    return Math.max(0, this.nextStartAtMs - this.monotonicNow());
  }
  reserveStart() {
    if (this.readyInMs() !== 0) return false;
    this.active += 1;
    this.nextStartAtMs = this.monotonicNow()
      + this.policy.execution.minRequestIntervalMs;
    return true;
  }
  release() {
    this.active = Math.max(0, this.active - 1);
  }
  maybeOpen(result) {
    if (!isProviderHealthSignificantResult(result)) return;
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
  async executeReserved(target, fetchTarget) {
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
            networkDiagnostic: null,
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
          networkDiagnostic: null,
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
      const errorClass = classifyProviderError(error);
      result = {
        target,
        jobs: [],
        error,
        providerResult: {
          ...baseProviderResult(target),
          status: 'error',
          skipReason: null,
          errorClass,
          errorMessage: providerErrorMessage(error),
          networkDiagnostic: ['network', 'timeout'].includes(errorClass)
            ? providerNetworkDiagnostic(error)
            : null,
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
    this.maybeOpen(result.providerResult);
    return result;
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
      networkDiagnostic: null,
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
async function executeReadyGroup({
  targets,
  globalConcurrency,
  guardFor,
  fetchTarget,
  sleep,
  report,
}) {
  if (!Number.isInteger(globalConcurrency) || globalConcurrency <= 0) {
    throw new Error('global provider concurrency must be a positive integer');
  }
  if (targets.length === 0) return [];

  const queues = new Map();
  for (const target of targets) {
    const guard = guardFor(target);
    const key = guard.identity.healthPartition;
    if (!queues.has(key)) queues.set(key, { guard, targets: [] });
    queues.get(key).targets.push(target);
  }
  for (const queue of queues.values()) {
    queue.targets.sort((left, right) => left.sequence - right.sequence);
  }

  const results = [];
  const active = new Set();
  let pending = targets.length;

  function addResult(result) {
    results.push(result);
    pending -= 1;
    report(result);
  }

  function flushOpenCircuits() {
    let changed = false;
    for (const queue of queues.values()) {
      if (!queue.guard.open || queue.targets.length === 0) continue;
      for (const target of queue.targets.splice(0)) {
        addResult(skippedResult(target, 'provider_circuit_open'));
        changed = true;
      }
    }
    return changed;
  }

  function nextReadyQueue() {
    let selected = null;
    for (const queue of queues.values()) {
      if (queue.targets.length === 0 || queue.guard.readyInMs() !== 0) continue;
      if (!selected || queue.targets[0].sequence < selected.targets[0].sequence) {
        selected = queue;
      }
    }
    return selected;
  }

  function earliestWaitMs() {
    let waitMs = Infinity;
    for (const queue of queues.values()) {
      if (queue.targets.length === 0) continue;
      waitMs = Math.min(waitMs, queue.guard.readyInMs());
    }
    return waitMs;
  }

  function launch(queue) {
    const target = queue.targets.shift();
    if (!queue.guard.reserveStart()) {
      queue.targets.unshift(target);
      return false;
    }
    let task;
    task = queue.guard.executeReserved(target, fetchTarget)
      .then((result) => addResult(result))
      .finally(() => {
        queue.guard.release();
        active.delete(task);
      });
    active.add(task);
    return true;
  }

  while (pending > 0) {
    flushOpenCircuits();
    let launched = false;
    while (active.size < globalConcurrency) {
      const queue = nextReadyQueue();
      if (!queue) break;
      launched = launch(queue) || launched;
    }
    if (pending === 0) break;
    if (launched) continue;

    const waitMs = earliestWaitMs();
    if (active.size === 0) {
      if (!Number.isFinite(waitMs)) {
        throw new Error('provider scheduler stalled with pending targets');
      }
      if (waitMs > 0) await sleep(waitMs);
      continue;
    }

    if (Number.isFinite(waitMs) && waitMs > 0 && active.size < globalConcurrency) {
      await waitForActiveOrDelay(active, waitMs, sleep);
    } else {
      await Promise.race(active);
    }
  }

  await Promise.all(active);
  return results.sort((left, right) => left.target.sequence - right.target.sequence);
}

export async function executeProviderTargets({
  targets,
  policy,
  globalConcurrency,
  fetchTarget,
  monotonicNow = () => performance.now(),
  sleep = defaultSleep,
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
      }));
    }
    return guards.get(identity.healthPartition);
  }
  async function executeGroup(group) {
    return executeReadyGroup({
      targets: group,
      globalConcurrency,
      guardFor,
      fetchTarget,
      sleep,
      report,
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
