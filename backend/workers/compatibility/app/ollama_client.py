# /app/ollama_client.py
import json
import requests
from typing import Any, Dict, Optional

class OllamaClient:
    def __init__(self, base_url: str, timeout_s: int = 180):
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s
        self.session = requests.Session()

    def generate_json(
        self,
        *,
        model: str,
        prompt: str,
        system: Optional[str],
        temperature: float,
        top_p: float,
        top_k: Optional[int] = None,
        min_p: Optional[float] = None,
        presence_penalty: Optional[float] = None,
        repetition_penalty: Optional[float] = None,
        num_predict: Optional[int] = None,   # maps old max_tokens-ish behavior
    ) -> Dict[str, Any]:
        url = f"{self.base_url}/api/generate"

        options: Dict[str, Any] = {
            "temperature": temperature,
            "top_p": top_p,
        }
        if top_k is not None:
            options["top_k"] = top_k
        if min_p is not None:
            options["min_p"] = min_p
        if presence_penalty is not None:
            options["presence_penalty"] = presence_penalty
        if repetition_penalty is not None:
            options["repetition_penalty"] = repetition_penalty
        if num_predict is not None:
            options["num_predict"] = num_predict

        payload: Dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "stream": False,
            "format": "json",
            "options": options,
        }
        if system:
            payload["system"] = system

        resp = self.session.post(url, json=payload, timeout=self.timeout_s)
        resp.raise_for_status()
        data = resp.json()

        txt = data.get("response") or "{}"
        try:
            return json.loads(txt)
        except Exception as e:
            # Don’t crash the worker; let normalize_result carry the diagnostics.
            return {"__parse_error": str(e), "__raw": txt}