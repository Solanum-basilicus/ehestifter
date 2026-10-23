// Select a fixed-size diagnostic sample. This is not a random quality audit.
export function selectLocationShadowIndices(candidates, normalized, { limit = 120 } = {}) {
  if (candidates.length !== normalized.length) throw new Error('Location sample inputs have different lengths');
  function score(candidate, result) {
    const description = String(candidate.description ?? '');
    const raw = String(candidate.rawLocation ?? '');
    const remote = /remote/iu.test(`${candidate.remoteType ?? ''} ${raw}`);
    let value = 0;
    if ((candidate.applicationQuestions ?? []).length > 0) value += 100;
    if (/\b(?:work\s+authori[sz]|citizenship|visa\s+sponsor|right\s+to\s+work|work\s+permit)\b/iu.test(description)) value += 70;
    if (/\b(?:DACH|EMEA|LATAM|APAC|European\s+Union|EU\s+Remote)\b/u.test(description)) value += 30;
    if (remote) value += 15;
    if ((result.locationsV2 ?? []).length === 0) value += 20;
    return value;
  }
  // The tie breaker is stable across runs and independent of arrival order.
  function hash(text) {
    let result = 2166136261;
    for (const char of text) result = Math.imul(result ^ char.charCodeAt(0), 16777619) >>> 0;
    return result;
  }
  const ranked = candidates.map((candidate, index) => ({
    index, provider: candidate.sourceProvider ?? 'unknown',
    score: score(candidate, normalized[index]),
    hash: hash(`${candidate.sourceProvider ?? ''}:${candidate.url ?? index}`),
  })).sort((a, b) => b.score - a.score || a.hash - b.hash || a.index - b.index);
  const chosen = [];
  const seen = new Set();
  const providerCounts = new Map();
  const providerLimit = Math.max(10, Math.ceil(limit / 3));
  for (const item of ranked) {
    if ((providerCounts.get(item.provider) ?? 0) >= providerLimit) continue;
    chosen.push(item.index);
    seen.add(item.index);
    providerCounts.set(item.provider, (providerCounts.get(item.provider) ?? 0) + 1);
    if (chosen.length >= limit) return chosen;
  }
  for (const item of ranked) {
    if (seen.has(item.index)) continue;
    chosen.push(item.index);
    if (chosen.length >= limit) break;
  }
  return chosen;
}

function candidateRef(candidate) {
  return {
    sourceProvider: candidate.sourceProvider ?? null,
    sourceTenant: candidate.sourceTenant ?? null,
    providerNativeId: candidate.provenance?.providerNativeId ?? null,
    url: candidate.url ?? null,
    title: candidate.title ?? null,
  };
}

function locationKeys(candidate) {
  return new Set((candidate.locationsV2 ?? []).map((item) => `${item.kind}:${item.locationId}`));
}

function compareClaims(current, baseline) {
  const currentSet = locationKeys(current);
  const baselineSet = locationKeys(baseline);
  return {
    conservative: [...currentSet].sort(),
    baseline: [...baselineSet].sort(),
    removedFromBaseline: [...baselineSet].filter((item) => !currentSet.has(item)).sort(),
    addedToBaseline: [...currentSet].filter((item) => !baselineSet.has(item)).sort(),
  };
}

export function compareLocationPolicies(conservative, baseline, { stage = 'final', population = conservative.length } = {}) {
  if (conservative.length !== baseline.length) {
    throw new Error('Location shadow inputs have different lengths');
  }
  const records = [];
  const totals = {
    compared: conservative.length,
    population,
    selection: 'bounded_targeted_provider_diverse_v1',
    changed: 0,
    baselineClaimCount: 0,
    conservativeClaimCount: 0,
    removedClaims: 0,
    addedClaims: 0,
    questionSignalJobs: 0,
    conservativeUnknown: 0,
  };
  for (let i = 0; i < conservative.length; i += 1) {
    const current = conservative[i];
    const previous = baseline[i];
    if (current.url !== previous.url || current.sourceProvider !== previous.sourceProvider) {
      throw new Error(`Location shadow identity mismatch at index ${i}`);
    }
    const comparison = compareClaims(current, previous);
    const changed = comparison.removedFromBaseline.length > 0 || comparison.addedToBaseline.length > 0;
    const questions = current.applicationQuestions ?? [];
    totals.baselineClaimCount += comparison.baseline.length;
    totals.conservativeClaimCount += comparison.conservative.length;
    totals.removedClaims += comparison.removedFromBaseline.length;
    totals.addedClaims += comparison.addedToBaseline.length;
    if (comparison.conservative.length === 0) totals.conservativeUnknown += 1;
    if (questions.length > 0) totals.questionSignalJobs += 1;
    if (changed) totals.changed += 1;
    // Keep a compact record for every final job so independent review can
    // measure unknown geography. Preliminary output contains changes only.
    if (stage === 'preliminary' && !changed) continue;
    records.push({
      ...candidateRef(current),
      remoteType: current.remoteType ?? null,
      rawLocation: current.rawLocation ?? null,
      detailRawLocation: current.detailRawLocation ?? null,
      changed,
      ...comparison,
      applicationQuestions: questions,
      conservativeEligibilityStatus: current.locationEligibility?.status ?? null,
      baselineEligibilityStatus: previous.locationEligibility?.status ?? null,
      claimEvidence: changed ? current.locationNormalization?.claimEvidence ?? [] : [],
      eligibilityEvidence: changed ? current.locationEligibility?.evidence ?? [] : [],
    });
  }
  return { stage, totals, records };
}

function scoreLlmSample(candidate, record) {
  let score = 0;
  if (record.changed) score += 100;
  if ((candidate.applicationQuestions ?? []).length > 0) score += 80;
  if ((candidate.remoteType ?? '').toLowerCase().includes('remote')) score += 20;
  if (record.conservative.length === 0) score += 15;
  if (record.removedFromBaseline.length > 0) score += 10;
  return score;
}

export function manualLlmReviewInputs(candidates, finalComparison, { limit = 30 } = {}) {
  if (candidates.length !== finalComparison.records.length) {
    throw new Error('Location LLM review inputs have different lengths');
  }
  const ranked = candidates.map((candidate, index) => ({
    candidate,
    record: finalComparison.records[index],
    index,
  })).sort((a, b) => scoreLlmSample(b.candidate, b.record) - scoreLlmSample(a.candidate, a.record)
    || a.index - b.index);
  return ranked.slice(0, limit).map(({ candidate, record }) => ({
    ...candidateRef(candidate),
    rawLocation: candidate.rawLocation ?? null,
    detailRawLocation: candidate.detailRawLocation ?? null,
    providerLocations: candidate.locations ?? [],
    remoteType: candidate.remoteType ?? null,
    // Public job description only. Avoid copying full ATS payloads.
    descriptionExcerpt: typeof candidate.description === 'string'
      ? candidate.description.slice(0, 8000) : '',
    applicationQuestions: candidate.applicationQuestions ?? [],
    conservativeClaims: record.conservative,
    baselineClaims: record.baseline,
    claimEvidence: candidate.locationNormalization?.claimEvidence ?? [],
  }));
}
