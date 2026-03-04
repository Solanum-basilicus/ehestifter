# /app/llama_cpp_client.py
import json
import requests
from typing import Any, Dict, Optional


class LlamaCppClient:
    """
    Minimal OpenAI-chat compatible client for llama.cpp native server.

    Calls:
      POST {base_url}/v1/chat/completions

    Returns:
      - dict parsed from assistant message content (JSON), augmented with "__llama_cpp" metadata
      - OR {"__parse_error": ..., "__raw": ..., "__llama_cpp": ...} on parse failures

    response_format behavior:
      - format is None -> omit response_format
      - format == "json" -> response_format {"type":"json_object"}
      - format is a JSON-schema dict -> response_format {"type":"json_object","schema": <dict>}
        (matches llama.cpp server README examples)
    """

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
        num_predict: Optional[int] = None,   # maps to max_tokens
        format: Any = "json",                # "json", schema dict, or None
    ) -> Dict[str, Any]:
        url = f"{self.base_url}/v1/chat/completions"

        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        payload: Dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "top_p": top_p,
            "stream": False,
        }

        # OpenAI name
        if num_predict is not None:
            payload["max_tokens"] = int(num_predict)

        # llama.cpp supports these knobs (server-side samplers/penalties)
        # (Even if some are "non-OpenAI", llama.cpp accepts them.)
        if top_k is not None:
            payload["top_k"] = int(top_k)
        if min_p is not None:
            payload["min_p"] = float(min_p)
        if presence_penalty is not None:
            payload["presence_penalty"] = float(presence_penalty)

        # Your config uses "repetition_penalty"; llama.cpp uses "repeat_penalty"
        if repetition_penalty is not None:
            payload["repeat_penalty"] = float(repetition_penalty)

        # response_format handling (omit if None)
        if format is not None:
            if format == "json":
                payload["response_format"] = {"type": "json_object"}
            elif isinstance(format, dict):
                payload["response_format"] = {"type": "json_object", "schema": format}
            else:
                # if caller passes something unexpected, still try "json_object"
                payload["response_format"] = {"type": "json_object"}

        resp = self.session.post(url, json=payload, timeout=self.timeout_s)
        resp.raise_for_status()
        data = resp.json()

        # Standard OpenAI-like shape:
        # choices[0].message.content is a string
        content = ""
        try:
            content = (
                (data.get("choices") or [{}])[0]
                .get("message", {})
                .get("content", "")
            )
        except Exception:
            content = ""

        content_s = "" if content is None else str(content)

        envelope = {
            "__llama_cpp": {
                "id": data.get("id"),
                "model": data.get("model"),
                "created": data.get("created"),
                "finish_reason": ((data.get("choices") or [{}])[0].get("finish_reason")),
                "usage": data.get("usage"),
                "response_len": len(content_s),
            }
        }

        # Preserve empty response for diagnostics
        if not content_s.strip():
            return {"__parse_error": "empty_response", "__raw": content_s, **envelope}

        # Strict JSON parse (your normalize_result handles missing fields)
        try:
            obj = json.loads(content_s)
        except Exception as e:
            return {"__parse_error": f"json_loads_failed: {e}", "__raw": content_s, **envelope}

        if isinstance(obj, dict):
            obj.update(envelope)
            return obj

        return {"__parse_error": "non_object_json", "__raw": content_s, **envelope}