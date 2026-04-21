from __future__ import annotations

from typing import Any

from .config import Settings
from .http import RetryingSession
from .models import QuerySpec


class AdzunaClient:
    def __init__(self, settings: Settings):
        self._settings = settings
        self._http = RetryingSession(timeout_seconds=settings.timeout_seconds)

    def search_page(self, spec: QuerySpec, page: int) -> dict[str, Any]:
        url = f"{self._settings.base_url}/jobs/{spec.country}/search/{page}"
        params = {
            "app_id": self._settings.app_id,
            "app_key": self._settings.app_key,
            "results_per_page": spec.results_per_page,
            "what": spec.what,
            "sort_by": spec.sort_by,
            "content-type": "application/json",
        }
        return self._http.get_json(url, params=params)
