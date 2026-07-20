import { performance } from 'node:perf_hooks';

import { getProviderPolicy } from '../policy/discovery-policy.mjs';
import {
  classifyProviderError,
  isTransientProviderResult,
  providerErrorMessage,
  providerHttpStatus,
} from './provider-errors.mjs';

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

class ProviderGuard {
  constructor({ provider, policy, monotonicNow, sleep }) {
    this.provider = provider;
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

  maybeOpen(result) {
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
        provider: this.provider,
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
        const jobs = await fetchTarget(target);
        if (!Array.isArray(jobs)) {
          const error = new Error('Provider returned a non-array job list');
          error.code = 'INVALID_PROVIDER_RESULT';
          throw error;
        }
        result = {
          target,
          jobs,
          error: null,
          providerResult: {
            sequence: target.sequence,
            provider: target.provider,
            tenant: target.tenant,
            targetClass: target.targetClass,
            status: 'ok',
            skipReason: null,
            errorClass: null,
            errorMessage: null,
            httpStatus: null,
            jobsReturned: jobs.length,
            candidatesMatched: 0,
            candidatesRetained: 0,
            candidatesDroppedByCap: 0,
            durationMs: Math.max(0, Math.round(this.monotonicNow() - started)),
          },
        };
      } catch (error) {
        result = {
          target,
          jobs: [],
          error,
          providerResult: {
            sequence: target.sequence,
            provider: target.provider,
            tenant: target.tenant,
            targetClass: target.targetClass,
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
          },
        };
      }
      this.maybeOpen(result.providerResult);
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
      sequence: target.sequence,
      provider: target.provider,
      tenant: target.tenant,
      targetClass: target.targetClass,
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
}) {
  if (!Array.isArray(targets)) throw new Error('targets must be an array');
  if (typeof fetchTarget !== 'function') throw new Error('fetchTarget must be a function');

  const guards = new Map();
  function guardFor(provider) {
    if (!guards.has(provider)) {
      guards.set(provider, new ProviderGuard({
        provider,
        policy: getProviderPolicy(policy, provider),
        monotonicNow,
        sleep,
      }));
    }
    return guards.get(provider);
  }

  async function executeGroup(group) {
    return mapLimit(group, globalConcurrency, (target) => (
      guardFor(target.provider).execute(target, fetchTarget)
    ));
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
    .sort((left, right) => left.provider.localeCompare(right.provider));

  return { batches, breakerEvents };
}
