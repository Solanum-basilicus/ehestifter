const MAX_DIAGNOSTIC_TEXT = 500;
const MAX_CAUSE_DEPTH = 5;

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429]);
const RETRYABLE_ERROR_CODES = new Set([
  'ABORT_ERR',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export const EXIT_ABORTED_RETRYABLE = 75;
export const EXIT_FAILED_PREREQUISITE = 64;

function boundedText(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text
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
    .trim()
    .slice(0, MAX_DIAGNOSTIC_TEXT);
}

function boundedScalar(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    return boundedText(value).slice(0, 120);
  }
  return null;
}

function diagnosticEntry(error) {
  if (error == null) {
    return {
      name: 'Error',
      message: 'Unknown error',
      status: null,
      code: null,
      errno: null,
      syscall: null,
      hostname: null,
    };
  }
  if (typeof error !== 'object') {
    return {
      name: 'Error',
      message: boundedText(error),
      status: null,
      code: null,
      errno: null,
      syscall: null,
      hostname: null,
    };
  }
  const status = Number.isInteger(error.status) ? error.status : null;
  return {
    name: boundedText(error.name || error.constructor?.name || 'Error').slice(0, 120),
    // HTTP client messages may include response bodies. Status is sufficient
    // for classification; never persist an arbitrary owner-service body here.
    message: status == null
      ? boundedText(error.message || String(error))
      : `HTTP ${status}`,
    status,
    code: boundedScalar(error.code),
    errno: boundedScalar(error.errno),
    syscall: boundedScalar(error.syscall),
    hostname: boundedScalar(error.hostname),
  };
}

export function buildErrorDiagnostic(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (current != null && chain.length < MAX_CAUSE_DEPTH) {
    if (typeof current === 'object') {
      if (seen.has(current)) break;
      seen.add(current);
    }
    chain.push(diagnosticEntry(current));
    current = typeof current === 'object' ? current.cause : null;
  }
  if (chain.length === 0) chain.push(diagnosticEntry(error));
  return {
    schemaVersion: 1,
    message: chain[0].message,
    chain,
  };
}

export function isRetryablePrerequisiteError(error) {
  const diagnostic = buildErrorDiagnostic(error);
  const statuses = diagnostic.chain
    .map((item) => item.status)
    .filter(Number.isInteger);
  if (statuses.length > 0) {
    return statuses.some(
      (status) => RETRYABLE_STATUS_CODES.has(status) || status >= 500,
    );
  }
  return diagnostic.chain.some((item) => (
    RETRYABLE_ERROR_CODES.has(String(item.code || '').toUpperCase())
    || ['AbortError', 'TimeoutError'].includes(item.name)
    || /\bfetch failed\b|\bnetwork error\b|\bsocket hang up\b|\btimed out\b/iu.test(
      item.message,
    )
  ));
}

export function classifyPrerequisiteFailure(error, stage = 'discovery_users_load') {
  const retryable = isRetryablePrerequisiteError(error);
  return {
    schemaVersion: 1,
    stage,
    outcome: retryable ? 'aborted_retryable' : 'failed_prerequisite',
    retryable,
    exitCode: retryable
      ? EXIT_ABORTED_RETRYABLE
      : EXIT_FAILED_PREREQUISITE,
    error: buildErrorDiagnostic(error),
  };
}

export function buildPrerequisiteFailureSummary(summary, failure) {
  return {
    ...summary,
    runStatus: failure.outcome,
    failureStage: failure.stage,
    retryable: failure.retryable,
    failure,
    targetsAttempted: 0,
    targetsNotAttemptedPrerequisite: summary.targetsPlanned ?? summary.targets ?? 0,
    providerSuccesses: 0,
    providerErrors: 0,
    providerRateLimited: 0,
    providerBreakersActivated: 0,
    providerVariants: {},
    providerHealthWarnings: [],
    providerHealthNotices: [],
    providerCanaries: 0,
    providerCanariesHealthy: 0,
    providerCanariesDegraded: 0,
    providerCanariesInconclusive: 0,
    rawJobsReturned: 0,
    tenantStateChanges: 0,
    tenantProviderStateChanges: 0,
    discoveryUsersLoadDiagnostic: failure.error,
  };
}
