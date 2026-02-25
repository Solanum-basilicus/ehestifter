import math

def find_run_in_items(items: list, run_id: str):
    rid = (run_id or "").lower()
    for it in items or []:
        if str(it.get("runId") or "").lower() == rid:
            return it
    return None

def compute_tail_offset(total: int, tail: int = 10) -> int:
    # offset such that we get up to `tail` newest items assuming RequestedAt ASC ordering
    return max(0, total - tail)