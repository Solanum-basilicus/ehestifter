from __future__ import annotations

import logging
from typing import Any, Dict, Optional

import requests

from helpers.errors import CoreHttpError
from helpers.settings import CORE_BASE_URL, CORE_FUNCTION_KEY, HTTP_TIMEOUT_SECONDS

_LOG_BODY_MAX = 2000


def _headers() -> Dict[str, str]:
    return {"x-functions-key": CORE_FUNCTION_KEY}


def _url(path: str) -> str:
    if not path.startswith("/"):
        path = "/" + path
    return f"{CORE_BASE_URL}{path}"


def _body_snippet(text: str | None) -> str:
    if not text:
        return ""
    compact = str(text).replace("\r", "\\r").replace("\n", "\\n")
    if len(compact) > _LOG_BODY_MAX:
        return compact[:_LOG_BODY_MAX] + "...[truncated]"
    return compact


def _request(method: str, path: str, **kwargs) -> requests.Response:
    """
    Core request wrapper.

    Logs upstream failures with method/path/status/body, but never logs function keys.
    Raises CoreHttpError(502, ...) for transport-level failures so callers can
    surface a consistent Gateway/Core error.
    """
    url = _url(path)

    try:
        resp = requests.request(
            method=method,
            url=url,
            headers=_headers(),
            timeout=HTTP_TIMEOUT_SECONDS,
            **kwargs,
        )
    except requests.RequestException as e:
        logging.exception(
            "Core request transport failed method=%s path=%s base=%s timeout=%s error_type=%s",
            method,
            path,
            CORE_BASE_URL,
            HTTP_TIMEOUT_SECONDS,
            type(e).__name__,
        )
        raise CoreHttpError(
            502,
            f"Core request transport failed: {type(e).__name__}: {e}",
        ) from e

    if resp.status_code >= 400:
        logging.warning(
            "Core request non-success method=%s path=%s base=%s status=%s body=%s",
            method,
            path,
            CORE_BASE_URL,
            resp.status_code,
            _body_snippet(resp.text),
        )
    else:
        logging.debug(
            "Core request ok method=%s path=%s status=%s",
            method,
            path,
            resp.status_code,
        )

    return resp


def _raise_if_bad(resp: requests.Response) -> None:
    if resp.status_code >= 400:
        raise CoreHttpError(resp.status_code, resp.text)


def get_run(run_id: str) -> Dict[str, Any]:
    path = f"/internal/enrichment/runs/{run_id}"
    resp = _request("GET", path)

    if resp.status_code == 404:
        raise CoreHttpError(404, resp.text)

    _raise_if_bad(resp)
    return resp.json()


def get_latest_id(subject_key: str, enricher_type: str) -> str:
    path = f"/internal/enrichment/subjects/{subject_key}/{enricher_type}/latest-id"
    resp = _request("GET", path)

    if resp.status_code == 404:
        raise CoreHttpError(404, resp.text)

    _raise_if_bad(resp)
    return resp.json()["runId"]


def lease_run(run_id: str, lease_token: str, lease_until_iso: str) -> Optional[str]:
    """
    Returns None if success, else returns conflict code from Core
    such as NOT_LATEST or ALREADY_LEASED.

    Raises CoreHttpError for non-409 errors.
    """
    path = f"/internal/enrichment/runs/{run_id}/lease"
    resp = _request(
        "POST",
        path,
        json={"leaseToken": lease_token, "leaseUntil": lease_until_iso},
    )

    if resp.status_code in (200, 204):
        return None

    if resp.status_code == 409:
        try:
            return resp.json().get("code") or "CONFLICT"
        except Exception:
            logging.warning(
                "Core lease conflict returned non-json body runId=%s body=%s",
                run_id,
                _body_snippet(resp.text),
            )
            return "CONFLICT"

    if resp.status_code == 404:
        raise CoreHttpError(404, resp.text)

    raise CoreHttpError(resp.status_code, resp.text)


def get_input(run_id: str) -> Dict[str, Any]:
    path = f"/internal/enrichment/runs/{run_id}/input"
    resp = _request("GET", path)

    if resp.status_code == 404:
        raise CoreHttpError(404, resp.text)

    if resp.status_code == 409:
        raise CoreHttpError(409, resp.text)

    _raise_if_bad(resp)
    return resp.json()


def complete_run_succeeded(run_id: str, score: float, summary: str) -> None:
    path = f"/enrichment/runs/{run_id}/complete"
    resp = _request(
        "POST",
        path,
        json={
            "status": "Succeeded",
            "result": {"score": score, "summary": summary},
        },
    )
    _raise_if_bad(resp)


def complete_run_failed(run_id: str, error_code: str, error_message: str) -> None:
    path = f"/enrichment/runs/{run_id}/complete"
    resp = _request(
        "POST",
        path,
        json={
            "status": "Failed",
            "errorCode": error_code,
            "errorMessage": error_message,
        },
    )
    _raise_if_bad(resp)