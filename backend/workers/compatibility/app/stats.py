# app/stats.py
import json
import os
import time
from dataclasses import dataclass, asdict
from typing import Optional

STATS_PATH = os.getenv("WORKER_STATS_PATH", "/tmp/worker_stats.json")

def _now() -> str:
    # ISO-ish, seconds resolution
    return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime())

@dataclass
class WorkerStats:
    started_at: str

    sb_polls: int = 0
    sb_polls_last_at: Optional[str] = None

    sb_messages: int = 0
    sb_messages_last_at: Optional[str] = None

    leases_ok: int = 0
    leases_ok_last_at: Optional[str] = None

    completes_ok: int = 0
    completes_ok_last_at: Optional[str] = None

    lease_refused: int = 0
    lease_refused_last_at: Optional[str] = None

    other_enricher_abandoned: int = 0
    other_enricher_last_at: Optional[str] = None

    errors: int = 0
    errors_last_at: Optional[str] = None

class Stats:
    def __init__(self) -> None:
        self.s = WorkerStats(started_at=_now())
        self.flush()

    def bump(self, field: str, ts_field: str) -> None:
        setattr(self.s, field, getattr(self.s, field) + 1)
        setattr(self.s, ts_field, _now())

    def error(self) -> None:
        self.bump("errors", "errors_last_at")

    def flush(self) -> None:
        tmp = STATS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(asdict(self.s), f, indent=2)
        os.replace(tmp, STATS_PATH)

def load_stats() -> dict:
    with open(STATS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)