import time
_MEMO = {}  # key -> {"data":..., "ts": float}

def memo_get(key: str, ttl: float):
    item = _MEMO.get(key)
    if item and time.time() - item["ts"] < ttl:
        return item["data"]
    return None

def memo_put(key: str, data):
    _MEMO[key] = {"data": data, "ts": time.time()}

# --- prefix invalidation helper for UI job lists ---
try:
    _MEMO  # type: ignore[name-defined]
except NameError:
    # Fallback if this module didn't yet define the backing store (kept compatible).
    _MEMO = {}  # { key: (value, inserted_at, ttl?) } or similar – only keys are used here.

def memo_invalidate_prefix(prefix: str) -> int:
    """
    Remove all memoized entries whose keys start with the given prefix.
    Returns number of removed entries.
    NOTE: Works with the module-level _MEMO dict used by memo_get/memo_put.
    If your implementation uses a different store, adjust accordingly.
    """
    # Collect to a list first to avoid 'dictionary changed size during iteration'.
    keys_to_delete = [k for k in list(_MEMO.keys()) if isinstance(k, str) and k.startswith(prefix)]
    for k in keys_to_delete:
        try:
            del _MEMO[k]
        except KeyError:
            pass
    return len(keys_to_delete)