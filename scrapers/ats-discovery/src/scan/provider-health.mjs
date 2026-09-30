import { isDurableProviderResult } from './provider-errors.mjs';

const MAINTENANCE_BUCKETS = new Set([
  'recovery',
  'dead_reprobe',
  'long_empty',
]);

export function isMaintenanceScheduleBucket(value) {
  return MAINTENANCE_BUCKETS.has(value);
}

export function isProviderHealthSignificantResult(result) {
  if (!result || result.status === 'skipped') return false;
  if (isDurableProviderResult(result)) return false;
  if (result.errorClass === 'rate_limited' || result.httpStatus === 429) return true;
  return !isMaintenanceScheduleBucket(result.scheduleBucket);
}
