from __future__ import annotations

import requests
from typing import Any, Dict, Optional
from helpers.settings import CORE_BASE_URL, CORE_FUNCTION_KEY, HTTP_TIMEOUT_SECONDS
from helpers.errors import CoreHttpError

def _headers() -> Dict[str, str]:
    return {"x-functions-key": CORE_FUNCTION_KEY}

def _url(path: str) -> str:
    if not path.startswith("/"):
        path = "/" + path
    return f"{CORE_BASE_URL}{path}"

def _raise_if_bad(resp: requests.Response) -> None:
    if resp.status_code >= 400:
        raise CoreHttpError(resp.status_code, resp.text)

def get_run(run_id: str) -> Dict[str, Any]:
    resp = requests.get(
        _url(f"/internal/enrichment/runs/{run_id}"),
        headers=_headers(),
        timeout=HTTP_TIMEOUT_SECONDS,
    )
    if resp.status_code == 404:
        raise CoreHttpError(404, resp.text)
    _raise_if_bad(resp)
    return resp.json()

def get_latest_id(subject_key: str, enricher_type: str) -> str:
    resp = requests.get(
        _url(f"/internal/enrichment/subjects/{subject_key}/{enricher_type}/latest-id"),
        headers=_headers(),
        timeout=HTTP_TIMEOUT_SECONDS,
    )
    if resp.status_code == 404:
        raise CoreHttpError(404, resp.text)
    _raise_if_bad(resp)
    return resp.json()["runId"]

def lease_run(run_id: str, lease_token: str, lease_until_iso: str) -> Optional[str]:
    """
    Returns None if success, else returns conflict code from Core (e.g. NOT_LATEST, ALREADY_LEASED).
    Raises CoreHttpError for non-409 errors.
    """
    resp = requests.post(
        _url(f"/internal/enrichment/runs/{run_id}/lease"),
        headers=_headers(),
        json={"leaseToken": lease_token, "leaseUntil": lease_until_iso},
        timeout=HTTP_TIMEOUT_SECONDS,
    )
    if resp.status_code in (200, 204):
        return None
    if resp.status_code == 409:
        try:
            return resp.json().get("code") or "CONFLICT"
        except Exception:
            return "CONFLICT"
    if resp.status_code == 404:
        raise CoreHttpError(404, resp.text)
    raise CoreHttpError(resp.status_code, resp.text)

def get_input(run_id: str) -> Dict[str, Any]:
    resp = requests.get(
        _url(f"/internal/enrichment/runs/{run_id}/input"),
        headers=_headers(),
        timeout=HTTP_TIMEOUT_SECONDS,
    )
    if resp.status_code == 404:
        raise CoreHttpError(404, resp.text)
    if resp.status_code == 409:
        # snapshot missing; treat as conflict with body
        raise CoreHttpError(409, resp.text)
    _raise_if_bad(resp)
    return resp.json()

def complete_run_succeeded(run_id: str, score: float, summary: str) -> None:
    resp = requests.post(
        _url(f"/enrichment/runs/{run_id}/complete"),
        headers=_headers(),
        json={"status": "Succeeded", "result": {"score": score, "summary": summary}},
        timeout=HTTP_TIMEOUT_SECONDS,
    )
    _raise_if_bad(resp)

def complete_run_failed(run_id: str, error_code: str, error_message: str) -> None:
    resp = requests.post(
        _url(f"/enrichment/runs/{run_id}/complete"),
        headers=_headers(),
        json={"status": "Failed", "errorCode": error_code, "errorMessage": error_message},
        timeout=HTTP_TIMEOUT_SECONDS,
    )
    _raise_if_bad(resp)
