import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDiscoveryPolicy } from '../src/policy/discovery-policy.mjs';
import { runTrackedScan } from '../src/scan/tracked-source.mjs';
import { normalizeCandidateLocations } from '../src/locations/normalizer.mjs';
import {
  annotatePreliminaryDiscoveryEligibility,
  isDefinitePreliminaryGeographyMismatch,
} from '../src/locations/discovery-eligibility.mjs';

const USER = '11111111-1111-4111-8111-111111111111';
const discoveryUser = {
  userId: USER,
  discoveryPreferences: {
    eligibility: {
      onSite: {
        includeLocations: [{ kind: 'country', locationId: 'iso3166:DE' }],
        excludeLocations: [], allowUnknownLocation: false,
      },
    },
  },
};

function job(id, location) {
  return {
    id: String(id), title: 'Engineer', company: 'Example',
    location, description: 'A position.',
    url: `https://example.test/jobs/${id}`,
  };
}

test('listing geography rejects definite mismatches before downstream admission', async () => {
  const jobs = [
    job(1, 'Toronto, Canada'), job(2, 'Berlin, Germany'),
    job(3, 'London'), job(4, 'Berlin, Germany'),
  ];
  const provider = { id: 'ashby', async fetch() { return jobs; } };
  const target = {
    sequence: 0, provider: 'ashby', tenant: 'example', name: 'Example',
    targetClass: 'priority', careers_url: 'https://jobs.ashbyhq.com/example',
    _provider: provider,
  };
  const result = await runTrackedScan({
    portalConfig: { max_posting_age_days: 30 },
    targets: [target], providers: new Map([['ashby', provider]]),
    policy: parseDiscoveryPolicy({ schema_version: 1, providers: { ashby: {} } }),
    concurrency: 1, upstreamRef: 'ref', nowMs: Date.now(),
    candidateMatcher: () => ({ allowed: true, matchedUserIds: [USER], matchedProfiles: [] }),
    applyPortalCandidateFilters: false,
    preliminaryEvaluator: (candidate) => {
      const [normalized] = normalizeCandidateLocations([candidate]);
      const annotated = annotatePreliminaryDiscoveryEligibility([normalized], [discoveryUser]);
      const checked = annotated.candidates[0];
      return {
        candidate: checked,
        reject: isDefinitePreliminaryGeographyMismatch(checked),
        warnings: annotated.warnings,
      };
    },
  });
  assert.deepEqual(result.candidates.map((item) => item.url.split('/').at(-1)), ['2', '3', '4']);
  assert.equal(result.preliminaryDiscoveryEligibility.rejectedBeforeDetail, 1);
  assert.equal(result.preliminaryDiscoveryEligibility.candidatesBeforeCheck, 4);
  assert.equal(result.candidateAdmission.candidateCapReached, false);
  assert.equal(result.rejectionCounts.no_user_location_match, 1);
  assert.equal(result.candidates[1].preliminaryGeography.status, 'mismatch');
});

test('a location mismatch for one user does not reject a shared job', () => {
  const canadaUser = {
    ...discoveryUser,
    userId: '22222222-2222-4222-8222-222222222222',
    discoveryPreferences: {
      eligibility: {
        onSite: {
          includeLocations: [{ kind: 'country', locationId: 'iso3166:CA' }],
          excludeLocations: [], allowUnknownLocation: false,
        },
      },
    },
  };
  const [normalized] = normalizeCandidateLocations([{
    ...job('shared', 'Toronto, Canada'),
    rawLocation: 'Toronto, Canada',
    remoteType: 'On-Site',
    matchedUserIds: [USER, canadaUser.userId],
  }]);
  const [checked] = annotatePreliminaryDiscoveryEligibility(
    [normalized], [discoveryUser, canadaUser],
  ).candidates;
  assert.equal(checked.preliminaryGeography.status, 'matched');
  assert.equal(isDefinitePreliminaryGeographyMismatch(checked), false);
  assert.deepEqual(checked.matchedUserIds, [USER, canadaUser.userId]);
});
