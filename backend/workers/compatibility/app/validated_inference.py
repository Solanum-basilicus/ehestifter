"""Validate one model response and allow one retry for invalid output."""
from dataclasses import dataclass
from typing import Any, Callable

from .compatibility import (
    InsufficientJobDescription,
    InvalidCompatibilityResult,
    validate_result,
)


@dataclass(frozen=True)
class CheckedInference:
    raw: dict[str, Any] | None
    lease_token: str
    error_code: str | None = None
    error_message: str | None = None
    retried: bool = False


def validate_with_content_retry(
    initial: Any,
    *,
    retry: Callable[[str], Any],
    on_invalid: Callable[[InvalidCompatibilityResult], None] | None = None,
) -> CheckedInference:
    """Do not retry a permanent input failure. Retry invalid output once."""
    try:
        validate_result(initial.raw)
    except InsufficientJobDescription as exc:
        return CheckedInference(None, initial.lease_token, "INSUFFICIENT_JOB_DESCRIPTION", str(exc))
    except InvalidCompatibilityResult as exc:
        if on_invalid:
            on_invalid(exc)
        # The retry can raise InferenceFatal. It carries the active lease.
        second = retry(initial.lease_token)
        try:
            validate_result(second.raw)
        except InsufficientJobDescription as retry_exc:
            return CheckedInference(
                None, second.lease_token, "INSUFFICIENT_JOB_DESCRIPTION", str(retry_exc), True,
            )
        except InvalidCompatibilityResult as retry_exc:
            return CheckedInference(
                None, second.lease_token, "INFERENCE_INVALID_RESULT",
                f"Invalid inference result after retry: {retry_exc}", True,
            )
        return CheckedInference(second.raw, second.lease_token, retried=True)
    return CheckedInference(initial.raw, initial.lease_token)
