from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Tuple

from helpers.settings import LEASE_TTL_MINUTES

def utcnow() -> datetime:
    return datetime.now(timezone.utc)

def compute_lease() -> Tuple[str, str]:
    token = str(uuid.uuid4())
    until = (utcnow() + timedelta(minutes=LEASE_TTL_MINUTES)).isoformat()
    return token, until

def require_fields(obj: Dict[str, Any], fields: list[str]) -> Tuple[bool, str | None]:
    for f in fields:
        if obj.get(f) is None:
            return False, f
    return True, None

def is_latest(run: Dict[str, Any], latest_id: str) -> bool:
    return str(run.get("runId", "")).lower() == str(latest_id).lower()
