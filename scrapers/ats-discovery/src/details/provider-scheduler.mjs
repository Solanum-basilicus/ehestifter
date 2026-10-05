import { performance } from 'node:perf_hooks';

import { getProviderPolicy } from '../policy/discovery-policy.mjs';
import { providerHttpStatus } from '../scan/provider-errors.mjs';

const DEFAULT_RATE_LIMIT_RETRIES = 2;
const MAX_RATE_LIMIT_BACKOFF_MS = 60_000;
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

function fallbackPolicy(globalConcurrency) {
  return {
    execution: {
      concurrency: globalConcurrency,
      minRequestIntervalMs: 0,
    },
  };
}

function detailPolicy(policy, provider, globalConcurrency) {
  if (!policy || policy.schemaVersion !== 1) return fallbackPolicy(globalConcurrency);
  return getProviderPolicy(policy, provider);
}

function retryAfterMilliseconds(error, minRequestIntervalMs, wallNow) {
  const raw = typeof error?.retryAfter === 'string' ? error.retryAfter.trim() : '';
  if (/^\d+(?:\.\d+)?$/u.test(raw)) {
    return Math.min(
      MAX_RATE_LIMIT_BACKOFF_MS,
      Math.max(0, Math.ceil(Number(raw) * 1000)),
    );
  }
  if (raw) {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) {
      return Math.min(
        MAX_RATE_LIMIT_BACKOFF_MS,
        Math.max(0, parsed - wallNow()),
      );
    }
  }
  return Math.min(
    MAX_RATE_LIMIT_BACKOFF_MS,
    Math.max(2_000, minRequestIntervalMs * 2),
  );
}

class DetailProviderGuard {
  constructor({ provider, healthPartition, policy, monotonicNow }) {
    this.provider = provider;
    this.healthPartition = healthPartition;
    this.policy = policy;
    this.monotonicNow = monotonicNow;
    this.active = 0;
    this.nextStartAtMs = Number.NEGATIVE_INFINITY;
  }

  readyInMs(item) {
    if (this.active >= this.policy.execution.concurrency) return Infinity;
    return Math.max(
      0,
      this.nextStartAtMs - this.monotonicNow(),
      item.notBeforeMs - this.monotonicNow(),
    );
  }

  reserveStart(item) {
    if (this.readyInMs(item) !== 0) return false;
    this.active += 1;
    this.nextStartAtMs = this.monotonicNow()
      + this.policy.execution.minRequestIntervalMs;
    return true;
  }

  defer(milliseconds) {
    this.nextStartAtMs = Math.max(
      this.nextStartAtMs,
      this.monotonicNow() + Math.max(0, milliseconds),
    );
  }

  release() {
    this.active = Math.max(0, this.active - 1);
  }
}

function safeProgress(onProgress, completed, total) {
  if (!onProgress) return;
  try {
    onProgress({
      stage: 'details',
      current: completed,
      total,
    });
  } catch {
    /* Progress is diagnostic and must not affect detail fetching. */
  }
}

export async function executeDetailRequests({
  items,
  globalConcurrency,
  policy = null,
  worker,
  providerFor,
  healthPartitionFor,
  rateLimitRetries = DEFAULT_RATE_LIMIT_RETRIES,
  monotonicNow = () => performance.now(),
  wallNow = () => Date.now(),
  sleep = defaultSleep,
  onProgress = null,
  onResult = null,
}) {
  if (!Array.isArray(items)) throw new Error('detail items must be an array');
  if (!Number.isInteger(globalConcurrency) || globalConcurrency <= 0) {
    throw new Error('detail concurrency must be a positive integer');
  }
  if (!Number.isInteger(rateLimitRetries) || rateLimitRetries < 0) {
    throw new Error('detail rateLimitRetries must be a non-negative integer');
  }
  if (typeof worker !== 'function') throw new Error('detail worker must be a function');
  if (onResult != null && typeof onResult !== 'function') {
    throw new Error('detail onResult must be a function');
  }
  if (items.length === 0) return [];

  const guards = new Map();
  const queues = new Map();
  for (const item of items) {
    const provider = providerFor(item);
    const healthPartition = healthPartitionFor(item) || provider;
    if (!guards.has(healthPartition)) {
      guards.set(healthPartition, new DetailProviderGuard({
        provider,
        healthPartition,
        policy: detailPolicy(policy, provider, globalConcurrency),
        monotonicNow,
      }));
    }
    if (!queues.has(healthPartition)) {
      queues.set(healthPartition, {
        guard: guards.get(healthPartition),
        items: [],
      });
    }
    queues.get(healthPartition).items.push({
      item,
      attempts: 0,
      rateLimitedResponses: 0,
      notBeforeMs: Number.NEGATIVE_INFINITY,
      startedAtMs: null,
    });
  }

  const results = [];
  const active = new Set();
  let pending = items.length;
  let completed = 0;

  function complete(state, guard, value, error) {
    const result = {
      item: state.item,
      provider: guard.provider,
      healthPartition: guard.healthPartition,
      value,
      error,
      attempts: state.attempts,
      rateLimitedResponses: state.rateLimitedResponses,
      durationMs: Math.max(
        0,
        Math.round(monotonicNow() - (state.startedAtMs ?? monotonicNow())),
      ),
    };
    results.push(result);
    pending -= 1;
    completed += 1;
    if (onResult) {
      try {
        onResult(result);
      } catch {
        /* Run journaling must never alter detail execution. */
      }
    }
    safeProgress(onProgress, completed, items.length);
  }

  function nextReadyQueue() {
    let selected = null;
    for (const queue of queues.values()) {
      if (queue.items.length === 0) continue;
      if (queue.guard.readyInMs(queue.items[0]) !== 0) continue;
      const index = queue.items[0].item.index;
      if (!selected || index < selected.items[0].item.index) selected = queue;
    }
    return selected;
  }

  function earliestWaitMs() {
    let waitMs = Infinity;
    for (const queue of queues.values()) {
      if (queue.items.length === 0) continue;
      waitMs = Math.min(waitMs, queue.guard.readyInMs(queue.items[0]));
    }
    return waitMs;
  }

  function launch(queue) {
    const state = queue.items.shift();
    if (!queue.guard.reserveStart(state)) {
      queue.items.unshift(state);
      return false;
    }
    state.attempts += 1;
    if (state.startedAtMs == null) state.startedAtMs = monotonicNow();

    let task;
    task = Promise.resolve()
      .then(() => worker(state.item))
      .then((value) => complete(state, queue.guard, value, null))
      .catch((error) => {
        if (
          providerHttpStatus(error) === 429
          && state.rateLimitedResponses < rateLimitRetries
        ) {
          state.rateLimitedResponses += 1;
          const delayMs = retryAfterMilliseconds(
            error,
            queue.guard.policy.execution.minRequestIntervalMs,
            wallNow,
          );
          queue.guard.defer(delayMs);
          state.notBeforeMs = monotonicNow() + delayMs;
          queue.items.unshift(state);
          return;
        }
        if (providerHttpStatus(error) === 429) state.rateLimitedResponses += 1;
        complete(state, queue.guard, null, error);
      })
      .finally(() => {
        queue.guard.release();
        active.delete(task);
      });
    active.add(task);
    return true;
  }

  while (pending > 0) {
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
        throw new Error('detail scheduler stalled with pending requests');
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
  return results.sort((left, right) => left.item.index - right.item.index);
}
