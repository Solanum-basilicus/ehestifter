export const SUCCESSFACTORS_EXTERNAL_PREVIEW_MISSING = 'successfactors_external_preview_missing';
export const SUCCESSFACTORS_JOB_UNAVAILABLE = 'successfactors_job_unavailable';

const KNOWN_REASONS = new Set([
  SUCCESSFACTORS_EXTERNAL_PREVIEW_MISSING,
  SUCCESSFACTORS_JOB_UNAVAILABLE,
]);

// Do not use source text as a metric key.
export function unavailableReasonKey(reason) {
  return KNOWN_REASONS.has(reason) ? reason : 'other';
}
