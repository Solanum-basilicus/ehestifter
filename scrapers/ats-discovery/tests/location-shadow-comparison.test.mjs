import assert from 'node:assert/strict';
import test from 'node:test';
import { compareLocationPolicies, manualLlmReviewInputs, selectLocationShadowIndices } from '../src/locations/shadow-comparison.mjs';

function job(claims, extra = {}) {
  return {
    sourceProvider: 'greenhouse', sourceTenant: 'example', url: 'https://example.org/job/1',
    title: 'Engineer', remoteType: 'Remote', rawLocation: 'Remote',
    description: 'Role is remote. Candidates must have US work authorization.',
    locationsV2: claims,
    applicationQuestions: [{ label: 'US work authorization?', required: true }],
    locationNormalization: { claimEvidence: [] },
    ...extra,
  };
}

test('shadow comparison records a removed claim without changing the job', () => {
  const current = job([]);
  const baseline = job([{ kind: 'country', locationId: 'iso3166:US' }]);
  const result = compareLocationPolicies([current], [baseline]);
  assert.equal(result.totals.changed, 1);
  assert.equal(result.totals.removedClaims, 1);
  assert.deepEqual(result.records[0].removedFromBaseline, ['country:iso3166:US']);
  assert.deepEqual(current.locationsV2, []);
  const sample = manualLlmReviewInputs([current], result);
  assert.equal(sample[0].applicationQuestions.length, 1);
  assert.match(sample[0].descriptionExcerpt, /US work authorization/);
});

test('preliminary shadow stores only differences and validates candidate identity', () => {
  const current = job([]);
  assert.equal(compareLocationPolicies([current], [job([])], { stage: 'preliminary' }).records.length, 0);
  assert.throws(() => compareLocationPolicies([current], [job([], { url: 'https://other.example' })]), /identity mismatch/);
});

test('LLM sample inputs truncate job text and never copy private application fields', () => {
  const current = job([], { description: 'a'.repeat(10000) });
  const result = compareLocationPolicies([current], [current]);
  const sample = manualLlmReviewInputs([current], result);
  assert.equal(sample[0].descriptionExcerpt.length, 8000);
  assert.equal(sample[0].preflight, undefined);
});

test('shadow sample is bounded and does not use arrival order for equal scores', () => {
  const input = Array.from({ length: 400 }, (_, index) => job([], {
    url: `https://example.org/${index}`, sourceProvider: index < 300 ? 'greenhouse' : 'lever',
    applicationQuestions: [], description: '',
  }));
  const indices = selectLocationShadowIndices(input, input, { limit: 60 });
  assert.equal(indices.length, 60);
  assert.equal(new Set(indices).size, 60);
  assert.ok(indices.some((index) => index >= 300));
  assert.ok(indices.some((index) => index < 300));
});
