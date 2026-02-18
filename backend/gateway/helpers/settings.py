import os

def getenv_required(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Missing env var: {name}")
    return v

CORE_BASE_URL = getenv_required("EHESTIFTER_ENRICHERS_BASE_URL").rstrip("/")
CORE_FUNCTION_KEY = getenv_required("EHESTIFTER_ENRICHERS_FUNCTION_KEY")

SB_CONNECTION_STRING = getenv_required("GATEWAY_SB_CONNECTION_STRING")
SB_QUEUE_NAME = os.getenv("GATEWAY_SB_QUEUE_NAME", "enrichment-requests")

LEASE_TTL_MINUTES = int(os.getenv("GATEWAY_LEASE_TTL_MINUTES", "60"))
HTTP_TIMEOUT_SECONDS = float(os.getenv("GATEWAY_HTTP_TIMEOUT_SECONDS", "30"))
