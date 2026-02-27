import requests
from typing import Any, Dict

class GatewayClient:
    def __init__(self, base_url: str, api_key: str, timeout_s: int = 30):
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s
        self.session = requests.Session()
        self.session.headers.update({
            "x-functions-key": api_key,
            "content-type": "application/json",
        })

    def lease(self, run_id: str, lease_ttl_seconds: int) -> Dict[str, Any]:
        # You can shape this to match your gateway implementation.
        # Expect: { leaseToken, leaseUntil, input: {job..., cvText...} } or SAS URL
        url = f"{self.base_url}/work/lease"
        resp = self.session.post(url, json={"runId": run_id, "leaseTtlSeconds": lease_ttl_seconds}, timeout=self.timeout_s)
        resp.raise_for_status()
        return resp.json()

    def complete(self, run_id: str, lease_token: str, result: Dict[str, Any]) -> Dict[str, Any]:
        url = f"{self.base_url}/work/complete"
        payload = {
            "runId": run_id,
            "leaseToken": lease_token,
            "result": result,
        }
        resp = self.session.post(url, json=payload, timeout=self.timeout_s)
        resp.raise_for_status()
        return resp.json()