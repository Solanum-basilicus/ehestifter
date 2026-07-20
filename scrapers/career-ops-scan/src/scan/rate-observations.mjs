import { getProviderPolicy } from '../policy/discovery-policy.mjs';
import {
  isDurableProviderResult,
  isTransientProviderResult,
} from './provider-errors.mjs';

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index];
}

function rounded(value) {
  return value == null ? null : Math.round(value * 1000) / 1000;
}

function recommendation(observation, providerPolicy) {
  const config = providerPolicy.recommendations;
  const execution = providerPolicy.execution;
  const attempted = observation.requestsAttempted;
  const transientRatio = attempted === 0
    ? 0
    : observation.transientErrors / attempted;
  const successRatio = attempted === 0
    ? 1
    : observation.successes / attempted;

  if (observation.rateLimited > 0 || observation.breakerActivated) {
    return {
      action: 'decrease',
      suggestedConcurrency: Math.max(1, execution.concurrency - 1),
      suggestedMinRequestIntervalMs: Math.max(
        execution.minRequestIntervalMs + 100,
        Math.ceil(execution.minRequestIntervalMs * 1.5),
      ),
      rationale: 'Rate limiting or a provider circuit breaker was observed.',
    };
  }
  if (
    attempted >= config.minimumRequests
    && transientRatio >= config.highTransientErrorRatio
  ) {
    return {
      action: 'decrease',
      suggestedConcurrency: Math.max(1, execution.concurrency - 1),
      suggestedMinRequestIntervalMs: Math.max(
        execution.minRequestIntervalMs + 50,
        Math.ceil(execution.minRequestIntervalMs * 1.25),
      ),
      rationale: 'Transient provider error ratio is above the review threshold.',
    };
  }
  if (
    attempted >= config.minimumRequests
    && successRatio >= config.healthySuccessRatio
    && observation.latencyMs.p95 != null
    && observation.latencyMs.p95 <= config.fastP95Ms
    && execution.concurrency < config.maximumSuggestedConcurrency
  ) {
    return {
      action: 'consider_increase',
      suggestedConcurrency: execution.concurrency + 1,
      suggestedMinRequestIntervalMs: execution.minRequestIntervalMs,
      rationale: 'The sample was healthy and latency remained below the review threshold.',
    };
  }
  return {
    action: 'hold',
    suggestedConcurrency: execution.concurrency,
    suggestedMinRequestIntervalMs: execution.minRequestIntervalMs,
    rationale: attempted < config.minimumRequests
      ? 'Not enough requests were observed for a tuning recommendation.'
      : 'No rate or reliability signal justifies a policy change.',
  };
}

export function buildRateObservations({
  providerResults,
  breakerEvents = [],
  policy,
  targetPlan,
  generatedAt = new Date(),
}) {
  const now = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
  if (Number.isNaN(now.getTime())) throw new Error('generatedAt must be a valid date');
  if (!Array.isArray(providerResults)) throw new Error('providerResults must be an array');

  const breakerByProvider = new Map(
    breakerEvents.map((event) => [event.provider, event]),
  );
  const groups = new Map();
  for (const result of providerResults) {
    if (!groups.has(result.provider)) groups.set(result.provider, []);
    groups.get(result.provider).push(result);
  }

  const providers = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, results]) => {
      const attemptedResults = results.filter((item) => item.status !== 'skipped');
      const durations = attemptedResults.map((item) => item.durationMs);
      const totalDuration = durations.reduce((sum, value) => sum + value, 0);
      const observation = {
        provider,
        targetsPlanned: results.length,
        requestsAttempted: attemptedResults.length,
        skippedByCircuit: results.filter(
          (item) => item.skipReason === 'provider_circuit_open',
        ).length,
        successes: results.filter((item) => item.status === 'ok').length,
        errors: results.filter((item) => item.status === 'error').length,
        rateLimited: results.filter(
          (item) => item.errorClass === 'rate_limited',
        ).length,
        durableTenantFailures: results.filter(isDurableProviderResult).length,
        transientErrors: results.filter(isTransientProviderResult).length,
        jobsReturned: results.reduce((sum, item) => sum + item.jobsReturned, 0),
        candidatesMatched: results.reduce(
          (sum, item) => sum + (item.candidatesMatched ?? item.candidatesRetained ?? 0),
          0,
        ),
        candidatesRetained: results.reduce(
          (sum, item) => sum + (item.candidatesRetained ?? 0),
          0,
        ),
        candidatesDroppedByCap: results.reduce(
          (sum, item) => sum + (item.candidatesDroppedByCap ?? 0),
          0,
        ),
        breakerActivated: breakerByProvider.has(provider),
        breakerReason: breakerByProvider.get(provider)?.reason ?? null,
        latencyMs: {
          min: durations.length === 0 ? null : Math.min(...durations),
          average: durations.length === 0 ? null : rounded(totalDuration / durations.length),
          p50: percentile(durations, 0.5),
          p95: percentile(durations, 0.95),
          max: durations.length === 0 ? null : Math.max(...durations),
        },
        policy: {
          concurrency: getProviderPolicy(policy, provider).execution.concurrency,
          minRequestIntervalMs:
            getProviderPolicy(policy, provider).execution.minRequestIntervalMs,
        },
      };
      return {
        ...observation,
        recommendation: recommendation(
          observation,
          getProviderPolicy(policy, provider),
        ),
      };
    });

  return {
    schemaVersion: 1,
    generatedAtUtc: now.toISOString(),
    sweep: targetPlan?.sweep ?? null,
    providers,
  };
}
