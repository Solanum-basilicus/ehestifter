import test from 'node:test';
import assert from 'node:assert/strict';
import { compatibilityDegraded } from '../src/ehestifter/compatibility-health.mjs';

test('one request failure is a notice', () => {
  assert.equal(compatibilityDegraded(1, 284), false);
  assert.equal(compatibilityDegraded(1, 1), false);
});
test('multiple failures degrade a material outage', () => {
  assert.equal(compatibilityDegraded(2, 20), true);
  assert.equal(compatibilityDegraded(5, 500), true);
  assert.equal(compatibilityDegraded(2, 284), false);
});
