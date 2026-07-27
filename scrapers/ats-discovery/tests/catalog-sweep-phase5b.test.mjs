import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregateCatalogSweeps } from '../src/targets/aggregate-catalog-sweep.mjs';

function sweep(overrides = {}) {
  return {
    targetFullSweepDays: 3,
    healthyRotationTenants: 3,
    promotedDailyTenants: 0,
    exceptionalDueTenants: 0,
    configuredNormalTargetsPerRun: 1,
    recommendedHealthyTargetsPerRun: 1,
    recommendedNormalTargetsPerRun: 1,
    estimatedHealthySweepDays: 3,
    feasibleAtConfiguredBudget: true,
    ...overrides,
  };
}

test('aggregate catalog sweep sums independent provider recommendations and uses slowest shard', () => {
  const result = aggregateCatalogSweeps({
    ashby: sweep({ recommendedHealthyTargetsPerRun: 1011, recommendedNormalTargetsPerRun: 1030, estimatedHealthySweepDays: 3031, feasibleAtConfiguredBudget: false }),
    greenhouse: sweep({ recommendedHealthyTargetsPerRun: 2778, recommendedNormalTargetsPerRun: 2779, estimatedHealthySweepDays: 926, feasibleAtConfiguredBudget: false }),
    lever: sweep({ recommendedHealthyTargetsPerRun: 1456, recommendedNormalTargetsPerRun: 1456, estimatedHealthySweepDays: 437, feasibleAtConfiguredBudget: false }),
    workday: sweep({ recommendedHealthyTargetsPerRun: 4294, recommendedNormalTargetsPerRun: 4294, estimatedHealthySweepDays: 6441, feasibleAtConfiguredBudget: false }),
  }, { globalCatalogLimit: 23, targetDays: 3 });

  assert.equal(result.recommendedHealthyTargetsPerRun, 9539);
  assert.equal(result.recommendedNormalTargetsPerRun, 9559);
  assert.equal(result.estimatedHealthySweepDays, 6441);
  assert.equal(result.feasibleAtConfiguredBudget, false);
});

test('aggregate catalog sweep stays unschedulable when one provider has no healthy capacity', () => {
  const result = aggregateCatalogSweeps({
    ashby: sweep({
      healthyRotationTenants: 3031,
      promotedDailyTenants: 13,
      exceptionalDueTenants: 6,
      estimatedHealthySweepDays: null,
      feasibleAtConfiguredBudget: false,
    }),
    greenhouse: sweep({ estimatedHealthySweepDays: 926, feasibleAtConfiguredBudget: false }),
  }, { globalCatalogLimit: 11, targetDays: 3 });

  assert.equal(result.estimatedHealthySweepDays, null);
  assert.equal(result.feasibleAtConfiguredBudget, false);
});
