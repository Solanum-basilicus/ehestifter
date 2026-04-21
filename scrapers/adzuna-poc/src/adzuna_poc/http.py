from __future__ import annotations

import time
from typing import Any

import requests


class RetryingSession:
    def __init__(self, timeout_seconds: float, max_attempts: int = 3, backoff_seconds: float = 1.0):
        self._timeout_seconds = timeout_seconds
        self._max_attempts = max_attempts
        self._backoff_seconds = backoff_seconds
        self._session = requests.Session()
        self._session.headers.update({"Accept": "application/json"})

    def get_json(self, url: str, params: dict[str, Any]) -> dict[str, Any]:
        last_error: Exception | None = None
        for attempt in range(1, self._max_attempts + 1):
            try:
                response = self._session.get(url, params=params, timeout=self._timeout_seconds)
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, dict):
                    raise ValueError("Expected JSON object payload from Adzuna")
                return payload
            except (requests.RequestException, ValueError) as exc:
                last_error = exc
                if attempt >= self._max_attempts:
                    break
                time.sleep(self._backoff_seconds * attempt)
        assert last_error is not None
        raise last_error
