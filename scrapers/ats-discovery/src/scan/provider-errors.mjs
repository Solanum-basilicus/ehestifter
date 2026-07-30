function errorChain(error) {
  const values = [];
  let current = error;
  const seen = new Set();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    values.push(current);
    current = current.cause;
  }
  return values;
}

export function providerHttpStatus(error) {
  return errorChain(error)
    .map((item) => Number(
      item.status
      ?? item.statusCode
      ?? item.response?.status,
    ))
    .find((value) => Number.isInteger(value)) ?? null;
}
export function classifyProviderError(error) {
  const chain = errorChain(error);
  if (chain.some((item) => item.name === 'AbortError')) return 'timeout';
  const codes = chain
    .map((item) => item.code)
    .filter((value) => typeof value === 'string');
  if (codes.includes('ETIMEDOUT')) return 'timeout';
  if (codes.includes('PROVIDER_CANARY_MINIMUM_JOBS')) return 'provider_anomaly';
  if (codes.includes('WORKDAY_TENANT_INVALID')) return 'workday_tenant_invalid';
  if (codes.includes('WORKDAY_TENANT_RESTRICTED')) return 'workday_tenant_restricted';
  if (codes.includes('WORKDAY_REQUEST_REJECTED')) return 'provider_schema';
  if (codes.includes('CSB_LISTING_SCHEMA_MISMATCH')) return 'provider_schema';
  if (codes.some((code) => [
    'CSB_SESSION_REJECTED',
    'CSB_BOOTSTRAP_TOKEN_MISSING',
  ].includes(code))) return 'provider_auth';
  const status = providerHttpStatus(error);
  if (status === 429) return 'rate_limited';
  if (status != null && status >= 400 && status < 500) return 'http_4xx';
  if (status != null && status >= 500) return 'http_5xx';
  const networkCodes = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
  ]);
  if (codes.some((code) => networkCodes.has(code))) return 'network';
  if (chain.some(
    (item) => item instanceof TypeError
      && /fetch failed|network|socket|connection/i.test(item.message),
  )) return 'network';
  return 'provider_error';
}
export function providerErrorMessage(error, maxLength = 500) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= maxLength
    ? message
    : `${message.slice(0, maxLength - 3)}...`;
}

export function isDurableProviderResult(result) {
  if (['workday_tenant_invalid', 'workday_tenant_restricted'].includes(
    result?.errorClass,
  )) return true;
  return result?.errorClass === 'http_4xx'
    && [404, 410].includes(result.httpStatus);
}
export function isTransientProviderResult(result) {
  if (!result || result.status !== 'error') return false;
  if (isDurableProviderResult(result)) return false;
  if (result.errorClass === 'http_4xx') {
    return [401, 403, 408].includes(result.httpStatus);
  }
  return [
    'timeout',
    'rate_limited',
    'http_5xx',
    'network',
    'provider_error',
    'provider_anomaly',
    'provider_schema',
    'provider_auth',
  ].includes(result.errorClass);
}
