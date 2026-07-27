import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLocationFilter,
  buildPostingAgeFilter,
  buildTitleFilter,
} from '../src/scan/filters.mjs';

test('short title acronyms use word boundaries', () => {
  const filter = buildTitleFilter({ positive: ['COO'] });
  assert.equal(filter('Chief Operating Officer (COO)'), true);
  assert.equal(filter('Project Coordinator'), false);
});

test('location always_allow wins over block', () => {
  const filter = buildLocationFilter({
    always_allow: ['Germany'],
    block: ['India'],
    allow: ['Remote'],
  });
  assert.equal(filter('Remote, Germany or India'), true);
  assert.equal(filter('Remote, India'), false);
});

test('undated jobs pass posting age filter', () => {
  const now = Date.parse('2026-07-15T00:00:00Z');
  const filter = buildPostingAgeFilter(10, now);
  assert.equal(filter(undefined), true);
  assert.equal(filter(Date.parse('2026-07-10T00:00:00Z')), true);
  assert.equal(filter(Date.parse('2026-06-01T00:00:00Z')), false);
});
