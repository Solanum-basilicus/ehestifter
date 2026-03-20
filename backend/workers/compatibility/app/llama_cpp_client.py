# /app/llama_cpp_client.py
import json
import re
import requests
from typing import Any, Dict, Optional


class LlamaCppClient:
    """
    Minimal OpenAI-chat compatible client for llama.cpp native server.
    """

    def __init__(self, base_url: str, timeout_s: int = 180):
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s
        self.session = requests.Session()

    @staticmethod
    def _sanitize_text(s: Optional[str]) -> str:
        if not s:
            return ""
        return "".join(ch for ch in str(s) if ch in ("\n", "\r", "\t") or ord(ch) >= 32)

    @staticmethod
    def _extract_pos_from_message(msg: str) -> Optional[int]:
        m = re.search(r"\bpos\s+(\d+)\b", msg or "")
        if not m:
            return None
        try:
            return int(m.group(1))
        except Exception:
            return None

    @staticmethod
    def _snippet_around_bytes(b: bytes, pos: int, radius: int = 120) -> str:
        if pos < 0:
            pos = 0
        start = max(0, pos - radius)
        end = min(len(b), pos + radius)
        chunk = b[start:end]
        s = chunk.decode("utf-8", errors="replace")
        s = s.replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
        return f"(bytes {start}:{end} of {len(b)}) {s}"

    @staticmethod
    def _build_envelope(data: Dict[str, Any], content_s: str) -> Dict[str, Any]:
        choices0 = (data.get("choices") or [{}])[0] if isinstance(data.get("choices"), list) else {}
        return {
            "__llama_cpp": {
                "id": data.get("id"),
                "model": data.get("model"),
                "created": data.get("created"),
                "finish_reason": choices0.get("finish_reason"),
                "usage": data.get("usage"),
                "response_len": len(content_s),
            }
        }

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
        format: Any = "json",
    ) -> Dict[str, Any]:
        url = f"{self.base_url}/v1/chat/completions"

        system_s = self._sanitize_text(system)
        prompt_s = self._sanitize_text(prompt)

        messages = []
        if system_s:
            messages.append({"role": "system", "content": system_s})
        messages.append({"role": "user", "content": prompt_s})

        payload: Dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": float(temperature),
            "top_p": float(top_p),
            "stream": False,
        }

        if num_predict is not None:
            payload["max_tokens"] = int(num_predict)

        # keep these disabled unless intentionally testing them
        # if top_k is not None:
        #     payload["top_k"] = int(top_k)
        # if min_p is not None:
        #     payload["min_p"] = float(min_p)

        if presence_penalty is not None:
            payload["presence_penalty"] = float(presence_penalty)

        # if repetition_penalty is not None:
        #     payload["repeat_penalty"] = float(repetition_penalty)

        if format is not None:
            if format == "json":
                payload["response_format"] = {"type": "json_object"}
            elif isinstance(format, dict):
                payload["response_format"] = {
                    "type": "json_schema",
                    "json_schema": {
                        "name": "compatibility_result",
                        "schema": format,
                        "strict": True,
                    },
                }
            else:
                payload["response_format"] = {"type": "json_object"}

        try:
            payload_json_str = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            payload_bytes = payload_json_str.encode("utf-8")
        except Exception as e:
            return {
                "__parse_error": f"client_json_dumps_failed: {e}",
                "__raw": "",
                "__client_debug": {"stage": "preflight_serialize"},
            }

        headers = {"Content-Type": "application/json", "Accept": "application/json"}

        try:
            resp = self.session.post(
                url,
                json=payload,
                headers=headers,
                timeout=(10, self.timeout_s),
            )
            resp.raise_for_status()
            data = resp.json()

        except requests.HTTPError as e:
            # enrich exception for caller-side logging / retry decisions
            status = getattr(getattr(e, "response", None), "status_code", None)
            body = ""
            try:
                body = (getattr(e.response, "text", "") or "")[:2000]
            except Exception:
                body = ""

            pos = self._extract_pos_from_message(body)
            client_debug: Dict[str, Any] = {
                "http_status": status,
                "request_bytes_len": len(payload_bytes),
            }
            if pos is not None:
                client_debug["parse_pos"] = pos
                client_debug["around"] = self._snippet_around_bytes(payload_bytes, pos)

            # attach debug info to exception so main.py can log it
            setattr(e, "_llama_cpp_debug", client_debug)
            setattr(e, "_llama_cpp_body", body)
            raise

        except (requests.Timeout, requests.ConnectionError):
            raise

        except Exception as e:
            return {
                "__parse_error": f"request_failed: {e}",
                "__raw": "",
                "__client_debug": {"request_bytes_len": len(payload_bytes)},
            }

        content = ""
        try:
            content = ((data.get("choices") or [{}])[0].get("message", {}) or {}).get("content", "")
        except Exception:
            content = ""

        content_s = "" if content is None else str(content)
        envelope = self._build_envelope(data, content_s)

        if not content_s.strip():
            return {
                "__parse_error": "empty_response",
                "__raw": content_s,
                "__llama_cpp": envelope["__llama_cpp"],
                "__server_debug": {
                    "choices0": (data.get("choices") or [{}])[0],
                },
            }

        try:
            obj = json.loads(content_s)
        except Exception as e:
            return {"__parse_error": f"json_loads_failed: {e}", "__raw": content_s, **envelope}

        if isinstance(obj, dict):
            obj.update(envelope)
            return obj

        return {"__parse_error": "non_object_json", "__raw": content_s, **envelope}