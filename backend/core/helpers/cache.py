import time
_MEMO = {}  # key -> {"data":..., "ts": float}

def memo_get(key: str, ttl: float):
    item = _MEMO.get(key)
    if item and time.time() - item["ts"] < ttl:
        return item["data"]
    return None

def memo_put(key: str, data):
    _MEMO[key] = {"data": data, "ts": time.time()}
