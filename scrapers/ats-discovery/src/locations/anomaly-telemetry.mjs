// Diagnostics only. A long location list can be legitimate.
// Do not remove job locations without job-specific source evidence.
const LARGE_CLAIM_THRESHOLD = 50;
const NEAR_DUPLICATE_OVERLAP = 0.9;
const MAX_OVERLAP_COMPARISONS = 5000;

function claimKeys(candidate) {
  return new Set((candidate.locationsV2 ?? [])
    .map((item) => `${item.kind}\u0000${item.locationId}`));
}

export function buildLocationAnomalyTelemetry(candidates = []) {
  const large = candidates.filter((candidate) => (
    (candidate.locationsV2?.length ?? 0) >= LARGE_CLAIM_THRESHOLD
  ));
  const groups = new Map();
  for (const candidate of large) {
    const key = `${candidate.sourceProvider ?? 'unknown'}:${candidate.sourceTenant ?? 'unknown'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  const overlappingPairs = [];
  let pairsChecked = 0;
  let pairComparisonTruncated = false;
  for (const [source, jobs] of groups) {
    const sets = jobs.map(claimKeys);
    for (let i = 0; i < jobs.length; i += 1) {
      for (let j = i + 1; j < jobs.length; j += 1) {
        if (pairsChecked >= MAX_OVERLAP_COMPARISONS) {
          pairComparisonTruncated = true;
          break;
        }
        pairsChecked += 1;
        const shared = [...sets[i]].filter((key) => sets[j].has(key)).length;
        const aRatio = shared / sets[i].size;
        const bRatio = shared / sets[j].size;
        if (aRatio < NEAR_DUPLICATE_OVERLAP || bRatio < NEAR_DUPLICATE_OVERLAP) continue;
        overlappingPairs.push({
          source,
          jobA: jobs[i].url ?? null,
          jobB: jobs[j].url ?? null,
          countA: sets[i].size,
          countB: sets[j].size,
          shared,
          overlapA: Number(aRatio.toFixed(4)),
          overlapB: Number(bRatio.toFixed(4)),
        });
      }
      if (pairComparisonTruncated) break;
    }
    if (pairComparisonTruncated) break;
  }
  return {
    largeClaimThreshold: LARGE_CLAIM_THRESHOLD,
    largeLocationSetCount: large.length,
    largestClaimCount: large.reduce((max, job) => Math.max(max, job.locationsV2.length), 0),
    largeBySource: Object.fromEntries([...groups].map(([source, jobs]) => [source, jobs.length])),
    nearDuplicatePairs: overlappingPairs.length,
    pairsChecked,
    pairComparisonTruncated,
    examples: large.slice(0, 10).map((job) => ({
      provider: job.sourceProvider ?? null,
      tenant: job.sourceTenant ?? null,
      url: job.url ?? null,
      title: job.title ?? null,
      claimCount: job.locationsV2.length,
    })),
    overlapExamples: overlappingPairs.slice(0, 10),
  };
}
