from __future__ import annotations

from dataclasses import dataclass
from typing import Any
import logging
import requests

from app.config import AppConfig

logger = logging.getLogger(__name__)

@dataclass(frozen=True)
class MixpanelResponse:
    status_code: int
    text: str
    json_body: Any | None


class MixpanelClient:
    def __init__(self, config: AppConfig):
        self._config = config

    def import_events(self, events: list[dict[str, Any]]) -> MixpanelResponse:
        if not events:
            return MixpanelResponse(status_code=200, text="", json_body=None)

        url = self._config.mixpanel_api_base_url.rstrip("/") + "/import"
        params = {
            "strict": "1" if self._config.mixpanel_strict else "0",
            "project_id": self._config.mixpanel_project_id,
        }

        logger.info(
            "mixpanel_import_request base_url=%s project_id_set=%s event_count=%s strict=%s",
            self._config.mixpanel_api_base_url.rstrip("/"),
            bool(self._config.mixpanel_project_id),
            len(events),
            self._config.mixpanel_strict,
        )

        response = requests.post(
            url,
            params=params,
            auth=(
                self._config.mixpanel_service_account_username,
                self._config.mixpanel_service_account_password,
            ),
            json=events,
            timeout=20,
        )

        try:
            json_body = response.json()
        except ValueError:
            json_body = None

        return MixpanelResponse(
            status_code=response.status_code,
            text=response.text[:4000],
            json_body=json_body,
        )
        