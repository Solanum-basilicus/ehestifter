import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLocationAnomalyTelemetry } from '../src/locations/anomaly-telemetry.mjs';

function largeJob(id, claims, tenant = 'vinci') {
  return {
    sourceProvider: 'softgarden', sourceTenant: tenant, url: `https://example.test/job/${id}`,
    title: `Job ${id}`,
    locationsV2: claims.map((locationId) => ({ kind: 'city', locationId })),
  };
}

test('large repeated location sets produce diagnostics without removing any claims', () => {
  const ids = Array.from({ length: 60 }, (_, i) => `city:${i}`);
  const first = largeJob('a', ids);
  const second = largeJob('b', ids.slice(0, 58).concat(['city:other']));
  const unrelated = largeJob('c', ids, 'other');
  const telemetry = buildLocationAnomalyTelemetry([first, second, unrelated]);
  assert.equal(telemetry.largeLocationSetCount, 3);
  assert.equal(telemetry.nearDuplicatePairs, 1);
  assert.equal(telemetry.overlapExamples[0].shared, 58);
  assert.equal(first.locationsV2.length, 60);
  assert.equal(second.locationsV2.length, 59);
});

test('small location lists do not create an anomaly', () => {
  assert.equal(buildLocationAnomalyTelemetry([largeJob('a', ['city:1'])]).largeLocationSetCount, 0);
});
