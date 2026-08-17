from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable, Iterable

from requests import ConnectionError, RequestException, Timeout

# A first 400/500 may be caused by the thinking/output shape and is allowed to
# use the existing no-thinking fallback. A repeated 400 is configuration/input
# failure, not an availability outage.
FALLBACK_HTTP_STATUSES = frozenset({400, 500})
TEMPORARY_HTTP_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504})


@dataclass(frozen=True)
class InferenceRunResult:
    raw: dict[str, Any]
    lease_token: str
    attempts: int
    recovery_cycles: int
    used_fallback: bool
    degraded_reason: str


class InferenceUnavailable(RuntimeError):
    def __init__(self, *, status: int | None, kind: str, attempts: int):
        self.status = status
        self.kind = kind
        self.attempts = attempts
        super().__init__(self.public_message)

    @property
    def public_message(self) -> str:
        if self.status is not None:
            return f"Inference service temporarily unavailable (HTTP {self.status})"
        return f"Inference service temporarily unavailable ({self.kind})"


class InferenceFatal(RuntimeError):
    def __init__(
        self,
        *,
        lease_token: str,
        code: str,
        public_message: str,
        attempts: int = 0,
    ):
        self.lease_token = lease_token
        self.code = code
        self.public_message = public_message
        self.attempts = attempts
        super().__init__(public_message)


def http_status(exc: BaseException) -> int | None:
    response = getattr(exc, "response", None)
    return getattr(response, "status_code", None)


def _temporary_kind(exc: BaseException) -> str | None:
    if isinstance(exc, Timeout):
        return "timeout"
    if isinstance(exc, ConnectionError):
        return "connection_error"
    status = http_status(exc)
    if status in TEMPORARY_HTTP_STATUSES:
        return "http_error"
    return None


def _attempt_batch(
    *,
    primary_call: Callable[[], dict[str, Any]],
    fallback_call: Callable[[], dict[str, Any]],
    retry_delays_seconds: Iterable[int],
    sleep: Callable[[float], None],
    on_attempt_error: Callable[[BaseException, int, bool], None] | None,
) -> tuple[dict[str, Any], int, bool, str]:
    delays = tuple(retry_delays_seconds)
    attempt = 0
    used_fallback = False
    degraded_reason = ""

    while True:
        attempt += 1
        call = fallback_call if used_fallback else primary_call
        try:
            return call(), attempt, used_fallback, degraded_reason
        except RequestException as exc:
            status = http_status(exc)
            temporary_kind = _temporary_kind(exc)
            first_fallback_candidate = (
                not used_fallback and status in FALLBACK_HTTP_STATUSES
            )
            retryable = temporary_kind is not None or first_fallback_candidate
            has_retry = attempt <= len(delays)
            will_retry = retryable and has_retry

            if on_attempt_error is not None:
                on_attempt_error(exc, attempt, will_retry)

            if will_retry:
                if not degraded_reason:
                    if isinstance(exc, Timeout):
                        degraded_reason = "initial inference timed out; retried without thinking"
                    elif isinstance(exc, ConnectionError):
                        degraded_reason = "initial inference connection failed; retried without thinking"
                    else:
                        degraded_reason = (
                            f"initial inference failed with status={status}; "
                            "retried without thinking"
                        )
                used_fallback = True
                sleep(float(delays[attempt - 1]))
                continue

            if temporary_kind is not None:
                raise InferenceUnavailable(status=status, kind=temporary_kind, attempts=attempt) from exc

            public_message = (
                f"Inference request failed (HTTP {status})"
                if status is not None
                else f"Inference request failed ({type(exc).__name__})"
            )
            raise InferenceFatal(
                lease_token="",
                code="INFERENCE_REQUEST_FAILED",
                public_message=public_message,
                attempts=attempt,
            ) from exc


def run_with_outage_recovery(
    *,
    initial_lease_token: str,
    primary_call: Callable[[], dict[str, Any]],
    fallback_call: Callable[[], dict[str, Any]],
    release_unavailable: Callable[[str, str], None],
    reacquire_lease: Callable[[], str],
    health_check: Callable[[], bool],
    retry_delays_seconds: Iterable[int],
    outage_cooldown_seconds: int,
    sleep: Callable[[float], None] = time.sleep,
    on_attempt_error: Callable[[BaseException, int, bool], None] | None = None,
    on_circuit_open: Callable[[InferenceUnavailable, int], None] | None = None,
    on_health_probe: Callable[[bool, int], None] | None = None,
) -> InferenceRunResult:
    """Run inference while keeping the current Service Bus message locked.

    On a temporary inference outage:
    1. report INFERENCE_UNAVAILABLE through Gateway; Enrichment Core returns the
       SQL run from Leased to Queued;
    2. retain and auto-renew the same Service Bus message;
    3. probe llama.cpp /health only after each cooldown;
    4. re-lease the same run and retry when health returns.

    No Service Bus abandon/redelivery loop is used, so a long outage does not
    consume MaxDeliveryCount or create a wave of leased runs.
    """
    lease_token = initial_lease_token
    attempts_total = 0
    recovery_cycles = 0
    used_fallback_any = False
    degraded_reasons: list[str] = []

    while True:
        try:
            raw, attempts, used_fallback, degraded_reason = _attempt_batch(
                primary_call=primary_call,
                fallback_call=fallback_call,
                retry_delays_seconds=retry_delays_seconds,
                sleep=sleep,
                on_attempt_error=on_attempt_error,
            )
            attempts_total += attempts
            used_fallback_any = used_fallback_any or used_fallback
            if degraded_reason and degraded_reason not in degraded_reasons:
                degraded_reasons.append(degraded_reason)
            return InferenceRunResult(
                raw=raw,
                lease_token=lease_token,
                attempts=attempts_total,
                recovery_cycles=recovery_cycles,
                used_fallback=used_fallback_any,
                degraded_reason="; ".join(degraded_reasons),
            )
        except InferenceFatal as exc:
            attempts_total += exc.attempts
            # Attach the currently active lease so the caller can terminally
            # report the error through the existing completion contract.
            raise InferenceFatal(
                lease_token=lease_token,
                code=exc.code,
                public_message=exc.public_message,
                attempts=attempts_total,
            ) from exc
        except InferenceUnavailable as exc:
            attempts_total += exc.attempts
            # The release call is intentionally performed before waiting. If it
            # fails, the exception escapes and the SB message is not settled;
            # normal redelivery remains the recovery path.
            release_unavailable(lease_token, exc.public_message)
            recovery_cycles += 1
            if on_circuit_open is not None:
                on_circuit_open(exc, recovery_cycles)

            probe_number = 0
            while True:
                sleep(float(outage_cooldown_seconds))
                probe_number += 1
                healthy = bool(health_check())
                if on_health_probe is not None:
                    on_health_probe(healthy, probe_number)
                if healthy:
                    break

            lease_token = reacquire_lease()
