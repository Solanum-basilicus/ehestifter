import os
import httpx

def _require_url(name: str) -> str:
    v = os.getenv(name)
    if not v or not v.startswith(("http://", "https://")):
        raise ValueError(f"{name} is missing or invalid (got: {v!r})")
    return v.rstrip("/")

# -----------------------------
# Gateway (existing, async)
# -----------------------------
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

# -----------------------------
# Jobs + Users (new, sync)
# -----------------------------
JOBS_BASE = os.getenv("EHESTIFTER_JOBS_BASE_URL", "").rstrip("/")
JOBS_KEY = os.getenv("EHESTIFTER_JOBS_FUNCTION_KEY")

USERS_BASE = os.getenv("EHESTIFTER_USERS_BASE_URL", "").rstrip("/")
USERS_KEY = os.getenv("EHESTIFTER_USERS_FUNCTION_KEY")

def _fn_key_headers(key: str | None) -> dict:
    hdrs = {}
    if key:
        hdrs["x-functions-key"] = key
    return hdrs

def get_job_snapshot(job_id: str, *, timeout_s: float = 10.0) -> dict:
    if not JOBS_BASE:
        raise ValueError("EHESTIFTER_JOBS_BASE_URL is not set")
    url = f"{JOBS_BASE}/internal/jobs/{job_id}/snapshot"
    with httpx.Client(timeout=timeout_s) as client:
        r = client.get(url, headers=_fn_key_headers(JOBS_KEY))
        r.raise_for_status()
        return r.json()

def get_user_cv_snapshot(user_id: str, *, timeout_s: float = 10.0) -> dict:
    if not USERS_BASE:
        raise ValueError("EHESTIFTER_USERS_BASE_URL is not set")
    url = f"{USERS_BASE}/users/internal/{user_id}/cv-snapshot"
    with httpx.Client(timeout=timeout_s) as client:
        r = client.get(url, headers=_fn_key_headers(USERS_KEY))
        r.raise_for_status()
        return r.json()