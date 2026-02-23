import requests
from typing import Any, Dict, Optional

class OllamaClient:
    def __init__(self, base_url: str, timeout_s: int = 180):
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s
        self.session = requests.Session()

    def generate_json(self, *, model: str, prompt: str, system: Optional[str], temperature: float, top_p: float) -> Dict[str, Any]:
        url = f"{self.base_url}/api/generate"
        payload: Dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "stream": False,
            # "format": "json" asks Ollama to constrain output to JSON
            "format": "json",
            "options": {
                "temperature": temperature,
                "top_p": top_p,
            },
        }
        if system:
            payload["system"] = system

        resp = self.session.post(url, json=payload, timeout=self.timeout_s)
        resp.raise_for_status()
        data = resp.json()

        # Ollama returns generated text in `response`
        # Example shape from docs: {"response":"...", "done":true, ...}
        txt = data.get("response") or "{}"
        # parse as json
        import json
        return json.loads(txt)