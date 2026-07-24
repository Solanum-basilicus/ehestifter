export function aggregateCatalogSweeps(catalogSweeps, { globalCatalogLimit, targetDays }) {
  const sweeps = Object.values(catalogSweeps);
  const sum = (field) => sweeps.reduce((total, sweep) => total + sweep[field], 0);
  const recommendedHealthyTargetsPerRun = sum('recommendedHealthyTargetsPerRun');
  const recommendedNormalTargetsPerRun = sum('recommendedNormalTargetsPerRun');
  const hasUnschedulableHealthyRotation = sweeps.some(
    (sweep) => sweep.healthyRotationTenants > 0 && sweep.estimatedHealthySweepDays == null,
  );
  const finiteEstimates = sweeps
    .map((sweep) => sweep.estimatedHealthySweepDays)
    .filter((value) => Number.isInteger(value));

  return {
    targetFullSweepDays: targetDays,
    healthyRotationTenants: sum('healthyRotationTenants'),
    promotedDailyTenants: sum('promotedDailyTenants'),
    exceptionalDueTenants: sum('exceptionalDueTenants'),
    configuredNormalTargetsPerRun: globalCatalogLimit,
    recommendedHealthyTargetsPerRun,
    recommendedNormalTargetsPerRun,
    estimatedHealthySweepDays: sweeps.length === 0
      ? 0
      : hasUnschedulableHealthyRotation
        ? null
        : Math.max(0, ...finiteEstimates),
    feasibleAtConfiguredBudget:
      sweeps.every((sweep) => sweep.feasibleAtConfiguredBudget)
      && globalCatalogLimit >= recommendedNormalTargetsPerRun,
  };
}
