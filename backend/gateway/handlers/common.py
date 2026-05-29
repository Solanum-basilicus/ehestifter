# handlers/common.py

import uuid
from typing import Any, Mapping


ResponseTuple = tuple[Any, int, dict[str, str]]


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
