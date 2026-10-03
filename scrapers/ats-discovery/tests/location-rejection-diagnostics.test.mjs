import test from 'node:test';
import assert from 'node:assert/strict';

import { geographyRejectionDetails } from '../src/locations/rejection-diagnostics.mjs';

test('geography rejection diagnostics retain reasons with explicit bounds', () => {
  const geography = Array.from({ length: 24 }, (_, index) => ({
    userId: `user-${index}`,
    allowed: false,
    reason: 'no_matching_location_branch',
    arrangement: 'remote',
    branch: null,
  }));
  const locationsV2 = Array.from({ length: 30 }, (_, index) => ({
    kind: 'city',
    locationId: `city:${index}`,
  }));
  const unresolved = Array.from({ length: 12 }, (_, index) => ({
    source: 'raw_location',
    raw: `${index}-${'x'.repeat(200)}`,
    reason: 'segment_unresolved',
  }));

  const result = geographyRejectionDetails({
    userMatch: { geography },
    locationsV2,
    locationNormalization: {
      status: 'unparsed_multiple',
      consistency: 'insufficient',
      unresolved,
    },
  });

  assert.equal(result.matchedUserCountBeforeLocation, 24);
  assert.equal(result.matchedUserIdsBeforeLocation.length, 20);
  assert.equal(result.geographyCount, 24);
  assert.equal(result.geography.length, 20);
  assert.equal(result.locationsV2Count, 30);
  assert.equal(result.locationsV2.length, 25);
  assert.equal(result.locationNormalization.unresolved.length, 10);
  assert.equal(result.locationNormalization.unresolved[0].raw.length, 160);
  assert.equal(result.geography[0].reason, 'no_matching_location_branch');
});
