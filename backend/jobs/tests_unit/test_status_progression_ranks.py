"""Check the canonical progression ranks without Azure dependencies."""

import sys
from pathlib import Path

JOBS_ROOT = Path(__file__).resolve().parents[1]
if str(JOBS_ROOT) not in sys.path:
    sys.path.insert(0, str(JOBS_ROOT))

from helpers.status_normalize import (
    STATUS_OPTIONS, STATUS_PROGRESSION_RANKS, status_progression_order_sql,
)


def test_all_canonical_statuses_have_explicit_progression_ranks():
    assert {s.lower() for s in STATUS_OPTIONS} <= set(STATUS_PROGRESSION_RANKS)
    ranks = STATUS_PROGRESSION_RANKS
    stages = [
        "applied", "screening booked", "screening done", "hm interview booked",
        "hm interview done", "more interviews booked", "more interviews done",
        "got offer", "accepted offer",
    ]
    assert [ranks[s] for s in stages] == sorted(ranks[s] for s in stages)
    assert len(set(ranks[s] for s in stages)) == len(stages)
    assert ranks["applied"] < 20 < ranks["screening booked"]
    for status in (
        "rejected with filled", "rejected with unfortunately",
        "withdrew applications", "turned down offer", "ignored",
    ):
        assert ranks["applied"] < 20 < ranks[status] < ranks["screening booked"]
    assert ranks["more interview booked"] == ranks["more interviews booked"]
    assert ranks["more interview done"] == ranks["more interviews done"]


def test_progression_sql_normalizes_status_and_keeps_unknown_above_applied():
    sql = status_progression_order_sql("us.Status")
    assert "LOWER(LTRIM(RTRIM(COALESCE(us.Status, ''))))" in sql
    for status, rank in STATUS_PROGRESSION_RANKS.items():
        assert f"WHEN '{status}' THEN {rank}" in sql
    assert "ELSE 20 END" in sql
