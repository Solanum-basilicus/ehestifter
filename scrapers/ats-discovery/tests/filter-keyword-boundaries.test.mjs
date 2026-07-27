import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLocationFilter,
  buildTitleEvaluator,
  buildTitleFilter,
  compileKeyword,
  matchedTitleKeywords,
} from '../src/scan/filters.mjs';

test('title keywords match complete words and phrases, not substrings', () => {
  const filter = buildTitleFilter({
    positive: ['Manager', 'Product Manager'],
    negative: ['Intern'],
  });

  assert.equal(filter('Partner Manager International (all genders)'), true);
  assert.equal(filter('International Partnerships Lead'), false);
  assert.equal(filter('Product-Manager, Platform'), true);
  assert.equal(filter('Product Management Lead'), false);
  assert.equal(filter('Software Intern'), false);
});

test('negative Intern does not reject International', () => {
  const filter = buildTitleFilter({
    positive: ['Manager'],
    negative: ['Intern'],
  });
  assert.equal(filter('Partner Manager International'), true);
  assert.equal(filter('Manager Intern'), false);
});

test('short location tokens use boundaries', () => {
  const matcher = compileKeyword('US');
  assert.equal(matcher('remote us only'), true);
  assert.equal(matcher('russia'), false);

  const location = buildLocationFilter({ allow: ['US', 'Germany'] });
  assert.equal(location('US Remote'), true);
  assert.equal(location('Russia'), false);
});

test('matchedTitleKeywords uses the same phrase semantics as filtering', () => {
  assert.deepEqual(
    matchedTitleKeywords('Senior Product-Manager', {
      positive: ['Product Manager', 'Manager', 'Intern'],
    }),
    ['Product Manager', 'Manager'],
  );
});


test('title evaluator exposes bounded matching diagnostics', () => {
  const evaluate = buildTitleEvaluator({
    positive: ['Manager', 'Quality'],
    negative: ['Intern'],
  });
  assert.deepEqual(evaluate('Partner Manager International'), {
    allowed: true,
    positiveMatches: ['manager'],
    negativeMatches: [],
  });
  assert.deepEqual(evaluate('Manager Intern'), {
    allowed: false,
    positiveMatches: ['manager'],
    negativeMatches: ['intern'],
  });
});
