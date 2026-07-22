import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLocationScopeFilter } from '../src/scan/location-scope.mjs';

function filter() {
  return buildLocationScopeFilter({
    enabled: true,
    allow: [
      'Germany', 'Europe', 'EU', 'EEA', 'EMEA', 'DACH',
      'Worldwide', 'Anywhere',
    ],
    block: ['United States', 'USA', 'US', 'Canada'],
  });
}

test('missing or disabled location-scope policy allows candidates', () => {
  assert.equal(buildLocationScopeFilter(null)('Remote').allowed, true);
  assert.equal(buildLocationScopeFilter({ enabled: false })('Remote (US)').allowed, true);
});

test('rejects explicit North America-only remote scopes', () => {
  for (const value of [
    'Remote (United States | Canada)',
    'Remote (US based)',
    'Remote - USA',
    'Remote, Canada',
    'US only',
    'Must be based in the United States',
    'Canada residents only',
  ]) {
    const result = filter()(value);
    assert.equal(result.allowed, false, value);
    assert.equal(result.reason, 'explicit_blocked_remote_scope');
    assert.ok(result.blockedMatches.length > 0, value);
  }
});

test('compatible European or global scope wins in mixed listings', () => {
  for (const value of [
    'Remote (Europe or US)',
    'Remote (United States | Canada | Germany)',
    'EMEA / United States',
    'Worldwide, including USA',
    'Anywhere',
  ]) {
    const result = filter()(value);
    assert.equal(result.allowed, true, value);
    assert.equal(result.reason, 'compatible_scope_present');
  }
});

test('generic remote and missing location remain eligible', () => {
  assert.equal(filter()('Remote').allowed, true);
  assert.equal(filter()('').allowed, true);
  assert.equal(filter()(null).allowed, true);
});

test('short tokens use boundaries and do not match ordinary words', () => {
  const result = filter()('Remote business operations');
  assert.equal(result.allowed, true);
  assert.deepEqual(result.blockedMatches, []);
});

test('blocked country mention without exclusive context is not over-rejected', () => {
  const result = filter()('New York, United States');
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'blocked_scope_not_explicitly_restrictive');
});

test('custom policy lists and markers are honored', () => {
  const custom = buildLocationScopeFilter({
    enabled: true,
    allow: ['Moon'],
    block: ['Mars'],
    restriction_markers: ['permit'],
  });
  assert.equal(custom('Remote Mars permit required').allowed, false);
  assert.equal(custom('Remote Moon or Mars').allowed, true);
});

test('invalid location-scope configuration fails clearly', () => {
  assert.throws(() => buildLocationScopeFilter([]), /must be an object/);
  assert.throws(
    () => buildLocationScopeFilter({ enabled: 'yes' }),
    /enabled must be boolean/,
  );
  assert.throws(
    () => buildLocationScopeFilter({ block: 'US' }),
    /block must be an array/,
  );
  assert.throws(
    () => buildLocationScopeFilter({ allow: [''] }),
    /non-empty string/,
  );
});
