import os
import httpx

def _require_url(name: str) -> str:
    v = os.getenv(name)
    if not v or not v.startswith(("http://", "https://")):
        raise ValueError(f"{name} is missing or invalid (got: {v!r})")
    return v.rstrip("/")

GATEWAY_BASE = os.getenv("EHESTIFTER_GATEWAY_BASE_URL", "").rstrip("/")
GATEWAY_KEY = os.getenv("EHESTIFTER_GATEWAY_FUNCTION_KEY")

def gateway_headers():
    hdrs = {}
    if GATEWAY_KEY:
        hdrs["x-functions-key"] = GATEWAY_KEY
    return hdrs

async def post_gateway(path: str, payload: dict):
    if not GATEWAY_BASE:
        raise ValueError("EHESTIFTER_GATEWAY_BASE_URL is not set")
    url = f"{GATEWAY_BASE}/{path.lstrip('/')}"
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.post(url, headers=gateway_headers(), json=payload)
        r.raise_for_status()
        return r.json() if r.content else None
