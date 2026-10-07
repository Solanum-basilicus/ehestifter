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
  if (codes.some((code) => [
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
  ].includes(code))) return 'timeout';
  if (codes.includes('PROVIDER_CANARY_MINIMUM_JOBS')) return 'provider_anomaly';
  if (codes.includes('WORKDAY_TENANT_INVALID')) return 'workday_tenant_invalid';
  if (codes.includes('WORKDAY_TENANT_RESTRICTED')) return 'workday_tenant_restricted';
  if (codes.includes('BAMBOOHR_TENANT_REDIRECTED')) return 'bamboohr_tenant_redirected';
  if (codes.includes('PAYLOCITY_TENANT_REDIRECTED')) return 'paylocity_tenant_redirected';
  if (codes.includes('PERSONIO_TENANT_REDIRECTED')) return 'personio_tenant_redirected';
  if (codes.includes('WORKDAY_REQUEST_REJECTED')) return 'provider_schema';
  if (codes.includes('ICIMS_WAF_CAPTCHA')) return 'waf_captcha';
  if (codes.includes('ICIMS_JIBE_QUERY_REJECTED')) return 'provider_schema';
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
    'EHOSTDOWN',
    'EHOSTUNREACH',
    'ENETDOWN',
    'ENETUNREACH',
    'EPIPE',
    'UND_ERR_SOCKET',
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

function boundedString(value, maxLength) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function boundedDiagnosticMessage(value, maxLength) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const sanitized = value
    .replace(/\bhttps?:\/\/[^\s]+/giu, (raw) => {
      try {
        const url = new URL(raw);
        return `${url.origin}${url.pathname}`;
      } catch {
        return raw.split(/[?#]/u, 1)[0];
      }
    })
    .replace(
      /\b(authorization|x-functions-key|api[-_ ]?key|token|code)(\s*[:=]\s*)[^\s,;]+/giu,
      '$1$2[redacted]',
    )
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return boundedString(sanitized, maxLength);
}

export function providerNetworkDiagnostic(error) {
  const diagnostic = {
    code: null,
    errno: null,
    syscall: null,
    hostname: null,
    timeoutClass: null,
    causes: [],
  };
  for (const item of errorChain(error).slice(0, 6)) {
    const cause = {
      name: boundedString(item.name, 100),
      message: boundedDiagnosticMessage(item.message, 300),
      code: boundedString(item.code, 80),
      errno: (typeof item.errno === 'number' || typeof item.errno === 'string')
        ? (typeof item.errno === 'string' ? boundedString(item.errno, 80) : item.errno)
        : null,
      syscall: boundedString(item.syscall, 80),
      hostname: boundedString(item.hostname, 253),
    };
    if (Object.values(cause).some((value) => value != null)) {
      diagnostic.causes.push(cause);
    }
    if (diagnostic.code == null) {
      diagnostic.code = boundedString(item.code, 80);
    }
    if (
      diagnostic.errno == null
      && (typeof item.errno === 'number' || typeof item.errno === 'string')
    ) {
      diagnostic.errno = typeof item.errno === 'string'
        ? boundedString(item.errno, 80)
        : item.errno;
    }
    if (diagnostic.syscall == null) {
      diagnostic.syscall = boundedString(item.syscall, 80);
    }
    if (diagnostic.hostname == null) {
      diagnostic.hostname = boundedString(item.hostname, 253);
    }
    if (
      diagnostic.timeoutClass == null
      && (
        item.name === 'AbortError'
        || item.name === 'TimeoutError'
        || /TIMEOUT/u.test(String(item.code ?? ''))
      )
    ) {
      diagnostic.timeoutClass = boundedString(
        item.code ?? item.name,
        100,
      );
    }
  }
  return Object.entries(diagnostic).some(([key, value]) => (
    key === 'causes' ? value.length > 0 : value != null
  ))
    ? diagnostic
    : null;
}

export function isDurableProviderResult(result) {
  if ([
    'workday_tenant_invalid',
    'workday_tenant_restricted',
    'bamboohr_tenant_redirected',
    'paylocity_tenant_redirected',
    'personio_tenant_redirected',
  ].includes(result?.errorClass)) return true;
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
    'waf_captcha',
  ].includes(result.errorClass);
}
