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
  ].includes(result.errorClass);
}
