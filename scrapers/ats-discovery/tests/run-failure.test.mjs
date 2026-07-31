import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXIT_ABORTED_RETRYABLE,
  EXIT_FAILED_PREREQUISITE,
  buildErrorDiagnostic,
  buildPrerequisiteFailureSummary,
  classifyPrerequisiteFailure,
  isRetryablePrerequisiteError,
} from '../src/run-failure.mjs';

test('preserves bounded nested transport diagnostics without URL secrets', () => {
  const cause = Object.assign(
    new Error('connect ENETUNREACH https://example.test/path?code=secret'),
    {
      code: 'ENETUNREACH',
      errno: -101,
      syscall: 'connect',
      hostname: 'example.test',
    },
  );
  const error = new TypeError('fetch failed', { cause });
  const diagnostic = buildErrorDiagnostic(error);

  assert.equal(diagnostic.message, 'fetch failed');
  assert.equal(diagnostic.chain.length, 2);
  assert.equal(diagnostic.chain[1].code, 'ENETUNREACH');
  assert.equal(diagnostic.chain[1].hostname, 'example.test');
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret/u);
});

test('classifies transport, rate-limit, and server failures as retryable', () => {
  assert.equal(
    isRetryablePrerequisiteError(
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('network'), { code: 'EAI_AGAIN' }),
      }),
    ),
    true,
  );
  assert.equal(
    isRetryablePrerequisiteError(Object.assign(new Error('rate limited'), { status: 429 })),
    true,
  );
  assert.equal(
    isRetryablePrerequisiteError(Object.assign(new Error('server error'), { status: 503 })),
    true,
  );
});

test('does not retry authentication or response-contract failures', () => {
  const unauthorized = Object.assign(
    new Error('Users API returned 401: {"token":"secret"}'),
    { status: 401 },
  );
  assert.equal(isRetryablePrerequisiteError(unauthorized), false);
  assert.equal(buildErrorDiagnostic(unauthorized).message, 'HTTP 401');
  assert.doesNotMatch(
    JSON.stringify(buildErrorDiagnostic(unauthorized)),
    /secret/u,
  );
  assert.equal(
    isRetryablePrerequisiteError(new Error('Users discovery response schemaVersion must be 1')),
    false,
  );

  assert.equal(classifyPrerequisiteFailure(unauthorized).exitCode, EXIT_FAILED_PREREQUISITE);
});

test('retryable prerequisite abort clears provider health and state metrics', () => {
  const failure = classifyPrerequisiteFailure(
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('route unavailable'), { code: 'ENETUNREACH' }),
    }),
  );
  const summary = buildPrerequisiteFailureSummary({
    targets: 12,
    targetsPlanned: 12,
    targetsAttempted: 2,
    providerSuccesses: 1,
    providerErrors: 1,
    providerVariants: { workday: { status: 'degraded' } },
    providerHealthWarnings: ['bad'],
    tenantStateChanges: 2,
    tenantProviderStateChanges: 1,
  }, failure);

  assert.equal(failure.exitCode, EXIT_ABORTED_RETRYABLE);
  assert.equal(summary.runStatus, 'aborted_retryable');
  assert.equal(summary.targetsAttempted, 0);
  assert.equal(summary.targetsNotAttemptedPrerequisite, 12);
  assert.deepEqual(summary.providerVariants, {});
  assert.deepEqual(summary.providerHealthWarnings, []);
  assert.equal(summary.tenantStateChanges, 0);
  assert.equal(summary.tenantProviderStateChanges, 0);
});
