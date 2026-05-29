# handlers/common.py

import uuid
import os
from typing import Any, Mapping


ResponseTuple = tuple[Any, int, dict[str, str]]

def get_header(headers: Mapping[str, Any] | None, name: str) -> str | None:
    if not headers:
        return None

    wanted = name.lower()
    for key, value in headers.items():
        if str(key).lower() == wanted:
            return str(value)

    return None


def require_gateway_key(headers: Mapping[str, Any] | None) -> ResponseTuple | None:
    """
    Shared service-level auth for both Azure wrapper and Cloud Run wrapper.

    This intentionally preserves the current Ehestifter x-functions-key trust model.
    """
    expected = os.getenv("GATEWAY_FUNCTION_KEY")

    if not expected:
        return json_error(
            "GATEWAY_MISCONFIGURED",
            500,
            "Missing env var: GATEWAY_FUNCTION_KEY",
        )

    actual = get_header(headers, "x-functions-key")

    if actual != expected:
        return json_error("UNAUTHORIZED", 401)

    return None

def correlation_id(headers: Mapping[str, Any] | None) -> str:
    """
    Use client-provided correlation/request id if present, otherwise generate one.

    Header lookup is case-insensitive because Azure Functions and Flask expose
    headers through different mapping implementations.
    """
    if not headers:
        return str(uuid.uuid4())

    lowered = {str(k).lower(): v for k, v in headers.items()}

    return (
        lowered.get("x-correlation-id")
        or lowered.get("x-ms-client-request-id")
        or lowered.get("x-request-id")
        or str(uuid.uuid4())
    )


def json_result(
    body: Any,
    status_code: int = 200,
    headers: dict[str, str] | None = None,
) -> ResponseTuple:
    return body, status_code, headers or {}


def text_result(
    text: str,
    status_code: int = 200,
    headers: dict[str, str] | None = None,
) -> ResponseTuple:
    return text, status_code, headers or {}


def json_error(
    code: str,
    status_code: int,
    message: Any | None = None,
    headers: dict[str, str] | None = None,
) -> ResponseTuple:
    payload: dict[str, Any] = {"code": code}
    if message is not None:
        payload["message"] = message
    return json_result(payload, status_code, headers)
