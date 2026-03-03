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
        num_predict: Optional[int] = None,
        format: Any = "json",  # allow schema object too
    ) -> Dict[str, Any]:
        url = f"{self.base_url}/api/generate"

        options: Dict[str, Any] = {"temperature": temperature, "top_p": top_p}
        if top_k is not None: options["top_k"] = top_k
        if min_p is not None: options["min_p"] = min_p
        if presence_penalty is not None: options["presence_penalty"] = presence_penalty
        if repetition_penalty is not None: options["repetition_penalty"] = repetition_penalty
        if num_predict is not None: options["num_predict"] = num_predict

        payload: Dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "stream": False,
            "format": format,
            "options": options,
        }
        if system:
            payload["system"] = system

        resp = self.session.post(url, json=payload, timeout=self.timeout_s)
        resp.raise_for_status()

        data = resp.json()
        txt = data.get("response")
        txt_s = "" if txt is None else str(txt)

        envelope = {
            "__ollama": {
                "done": data.get("done"),
                "done_reason": data.get("done_reason"),
                "model": data.get("model"),
                "created_at": data.get("created_at"),
                "eval_count": data.get("eval_count"),
                "prompt_eval_count": data.get("prompt_eval_count"),
                "response_len": len(txt_s),
            }
        }

        # If response is empty/whitespace, preserve it verbatim for diagnostics
        if not txt_s.strip():
            return {"__parse_error": "empty_response", "__raw": txt_s, **envelope}

        try:
            obj = json.loads(txt_s)
            if isinstance(obj, dict):
                obj.update(envelope)
                return obj
            return {"__parse_error": "non_object_json", "__raw": txt_s, **envelope}
        except Exception as e:
            return {"__parse_error": f"json_loads_failed: {e}", "__raw": txt_s, **envelope}