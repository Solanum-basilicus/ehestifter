import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDetailTelemetry } from '../src/details/telemetry.mjs';

function detailResult(provider, status, overrides = {}) {
  return {
    sourceProvider: provider,
    detail: {
      provider,
      status,
      attempts: 1,
      rateLimitedResponses: 0,
      ...overrides,
    },
  };
}

test('detail telemetry reports retries and rate limits by provider and phase', () => {
  const telemetry = buildDetailTelemetry({
    candidateResults: [
      detailResult('paylocity', 'ok', { attempts: 2, rateLimitedResponses: 1 }),
      detailResult('paylocity', 'error'),
      detailResult('greenhouse', 'ok'),
    ],
    canaryResults: [
      detailResult('paylocity', 'ok'),
    ],
  });

  assert.deepEqual(telemetry.totals, {
    candidates: 4,
    attempts: 5,
    rateLimitedResponses: 1,
    errors: 1,
  });
  assert.deepEqual(
    telemetry.providers.find((item) => item.provider === 'paylocity'),
    {
      provider: 'paylocity',
      candidates: 3,
      attempts: 4,
      rateLimitedResponses: 1,
      retriedCandidates: 1,
      ok: 2,
      alreadyPresent: 0,
      missingDescription: 0,
      unavailable: 0,
      errors: 1,
      unsupported: 0,
      skippedExisting: 0,
      skippedLimit: 0,
      skippedPreflightError: 0,
    },
  );
  assert.equal(telemetry.phases.candidates.find((item) => item.provider === 'paylocity').candidates, 2);
  assert.equal(telemetry.phases.canaries.find((item) => item.provider === 'paylocity').candidates, 1);
});
