from __future__ import annotations

import json
import random
from dataclasses import dataclass
from typing import Any
import logging
import requests

from app.config import AppConfig
from app.db import (
    fetch_due_dispatch_rows,
    mark_dispatch_dead,
    mark_dispatch_retry,
    mark_dispatch_sending,
    mark_dispatch_sent,
)
from app.mixpanel_client import MixpanelClient
from app.mixpanel_mapper import MappingError, map_event_to_mixpanel

logger = logging.getLogger(__name__)

@dataclass(frozen=True)
class DispatchCounters:
    attempted: int
    sent: int
    retry: int
    dead: int
    skipped: int
    export_enabled: bool

    def as_dict(self) -> dict[str, Any]:
        return {
            "attempted": self.attempted,
            "sent": self.sent,
            "retry": self.retry,
            "dead": self.dead,
            "skipped": self.skipped,
            "exportEnabled": self.export_enabled,
        }


def run_dispatch_once(config: AppConfig) -> DispatchCounters:
    if not config.mixpanel_export_enabled:
        logger.info("analytics_dispatch_skipped export_enabled=false")
        return DispatchCounters(
            attempted=0,
            sent=0,
            retry=0,
            dead=0,
            skipped=0,
            export_enabled=False,
        )

    rows = fetch_due_dispatch_rows(config, limit=config.mixpanel_batch_size)
    logger.info(
        "analytics_dispatch_due_rows count=%s batch_size=%s",
        len(rows),
        config.mixpanel_batch_size,
    )    
    if not rows:
        return DispatchCounters(
            attempted=0,
            sent=0,
            retry=0,
            dead=0,
            skipped=0,
            export_enabled=True,
        )

    mapped_events = []
    mapped_dispatch_ids = []
    dead = 0

    for row in rows:
        dispatch_id = row["DispatchId"]
        try:
            mapped_events.append(map_event_to_mixpanel(row))
            mapped_dispatch_ids.append(dispatch_id)
        except (MappingError, ValueError, TypeError, json.JSONDecodeError) as exc:
            mark_dispatch_dead(
                config,
                [dispatch_id],
                error_code=f"mapping:{type(exc).__name__}",
                error_json=str(exc),
            )
            dead += 1

    if not mapped_events:
        return DispatchCounters(
            attempted=0,
            sent=0,
            retry=0,
            dead=dead,
            skipped=0,
            export_enabled=True,
        )

    logger.info(
        "analytics_dispatch_mapped mapped=%s dead=%s",
        len(mapped_events),
        dead,
    )

    mark_dispatch_sending(config, mapped_dispatch_ids)

    client = MixpanelClient(config)

    try:
        response = client.import_events(mapped_events)
    except (requests.Timeout, requests.ConnectionError) as exc:
        logger.warning(
            "analytics_mixpanel_import_transport_error type=%s message=%s",
            type(exc).__name__,
            str(exc)[:500],
        )        
        delay = _retry_delay_seconds(_max_attempt_count(rows))
        mark_dispatch_retry(
            config,
            mapped_dispatch_ids,
            error_code=type(exc).__name__,
            error_json=str(exc),
            delay_seconds=delay,
        )
        return DispatchCounters(
            attempted=len(mapped_events),
            sent=0,
            retry=len(mapped_events),
            dead=dead,
            skipped=0,
            export_enabled=True,
        )

    response_text = response.text or json.dumps(response.json_body, default=str)

    logger.info(
        "analytics_mixpanel_import_response status_code=%s body_snippet=%s",
        response.status_code,
        (response.text or "")[:500],
    )

    if 200 <= response.status_code < 300:
        mark_dispatch_sent(config, mapped_dispatch_ids)
        logger.info("analytics_dispatch_mark_sent count=%s", len(mapped_dispatch_ids))
        return DispatchCounters(
            attempted=len(mapped_events),
            sent=len(mapped_events),
            retry=0,
            dead=dead,
            skipped=0,
            export_enabled=True,
        )

    if response.status_code == 400 or 400 <= response.status_code < 500 and response.status_code not in {401, 403, 429}:
        logger.warning(
            "analytics_dispatch_mark_dead count=%s status_code=%s",
            len(mapped_dispatch_ids),
            response.status_code,
        )
        mark_dispatch_dead(
            config,
            mapped_dispatch_ids,
            error_code=f"http_{response.status_code}",
            error_json=response_text,
        )
        return DispatchCounters(
            attempted=len(mapped_events),
            sent=0,
            retry=0,
            dead=dead + len(mapped_events),
            skipped=0,
            export_enabled=True,
        )

    if response.status_code in {401, 403, 429, 500, 502, 503, 504}:
        logger.warning(
            "analytics_dispatch_mark_retry count=%s status_code=%s",
            len(mapped_dispatch_ids),
            response.status_code,
        )
        delay = _retry_delay_seconds(_max_attempt_count(rows), auth_error=response.status_code in {401, 403})
        mark_dispatch_retry(
            config,
            mapped_dispatch_ids,
            error_code=f"http_{response.status_code}",
            error_json=response_text,
            delay_seconds=delay,
        )
        return DispatchCounters(
            attempted=len(mapped_events),
            sent=0,
            retry=len(mapped_events),
            dead=dead,
            skipped=0,
            export_enabled=True,
        )

    mark_dispatch_retry(
        config,
        mapped_dispatch_ids,
        error_code=f"http_{response.status_code}",
        error_json=response_text,
        delay_seconds=_retry_delay_seconds(_max_attempt_count(rows)),
    )
    return DispatchCounters(
        attempted=len(mapped_events),
        sent=0,
        retry=len(mapped_events),
        dead=dead,
        skipped=0,
        export_enabled=True,
    )


def _max_attempt_count(rows: list[dict[str, Any]]) -> int:
    if not rows:
        return 0
    return max(int(row.get("AttemptCount") or 0) for row in rows)


def _retry_delay_seconds(attempt_count: int, auth_error: bool = False) -> int:
    if auth_error:
        base = 15 * 60
    else:
        base = min(60 * 60, 2 ** min(attempt_count, 8) * 30)

    jitter = random.randint(0, max(5, base // 10))
    return base + jitter
    