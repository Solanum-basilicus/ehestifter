# /app/llama_cpp_client.py
import json
import re
import hashlib
import logging
import requests
from typing import Any, Dict, Optional, Tuple


class LlamaCppClient:
    def __init__(self, base_url: str, timeout_s: int = 180):
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s
        self.session = requests.Session()
        self.log = logging.getLogger("compat-worker.llama_cpp")

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

    @staticmethod
    def _redact_payload_for_log(payload: Dict[str, Any]) -> Dict[str, Any]:
        out = json.loads(json.dumps(payload))
        for i, msg in enumerate(out.get("messages", [])):
            content = msg.get("content")
            if isinstance(content, str):
                out["messages"][i]["content"] = {
                    "redacted": True,
                    "len": len(content),
                    "sha256_16": hashlib.sha256(content.encode("utf-8")).hexdigest()[:16],
                    "preview": content[:120].replace("\n", "\\n"),
                }
        return out

    @staticmethod
    def _strip_think_blocks(s: str) -> Tuple[str, bool]:
        original = s
        # remove complete <think>...</think> blocks
        s2 = re.sub(r"<think>.*?</think>\s*", "", s, flags=re.DOTALL | re.IGNORECASE)
        if s2 != original:
            return s2.strip(), True

        # if it starts with <think> but closing tag is absent, keep as-is
        return s.strip(), False

    @staticmethod
    def _extract_first_balanced_json_object(s: str) -> Optional[str]:
        """
        Extract first top-level JSON object, respecting strings/escapes.
        """
        start = s.find("{")
        if start == -1:
            return None

        depth = 0
        in_string = False
        escape = False

        for i in range(start, len(s)):
            ch = s[i]

            if in_string:
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == '"':
                    in_string = False
                continue

            if ch == '"':
                in_string = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return s[start:i + 1]

        return None

    @classmethod
    def _parse_json_from_content(cls, content_s: str) -> Tuple[Optional[Dict[str, Any]], Dict[str, Any]]:
        """
        Returns (obj, diagnostics). obj is dict on success, else None.
        """
        diag: Dict[str, Any] = {
            "had_think_block": False,
            "used_json_extraction": False,
        }

        clean_s = content_s.strip()
        clean_s, had_think = cls._strip_think_blocks(clean_s)
        diag["had_think_block"] = had_think

        # attempt 1: parse cleaned whole string
        try:
            obj = json.loads(clean_s)
            if isinstance(obj, dict):
                return obj, diag
        except Exception as e:
            diag["direct_parse_error"] = str(e)

        # attempt 2: extract first balanced JSON object
        candidate = cls._extract_first_balanced_json_object(clean_s)
        if candidate:
            diag["used_json_extraction"] = True
            try:
                obj = json.loads(candidate)
                if isinstance(obj, dict):
                    return obj, diag
                diag["candidate_parse_error"] = "parsed JSON was not an object"
            except Exception as e:
                diag["candidate_parse_error"] = str(e)
                diag["candidate_snippet"] = candidate[:2000]

        diag["cleaned_snippet"] = clean_s[:2000]
        return None, diag

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

        if presence_penalty is not None:
            payload["presence_penalty"] = float(presence_penalty)

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

        if self.log.isEnabledFor(logging.DEBUG):
            try:
                redacted = self._redact_payload_for_log(payload)
                self.log.debug(
                    "llama.cpp request url=%s payload=%s",
                    url,
                    json.dumps(redacted, ensure_ascii=False, separators=(",", ":")),
                )
            except Exception as log_exc:
                self.log.debug("llama.cpp request logging failed: %s", log_exc)

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

        obj, parse_diag = self._parse_json_from_content(content_s)
        if obj is not None:
            obj.update(envelope)
            obj["__parse_diag"] = parse_diag
            return obj

        return {
            "__parse_error": "json_loads_failed",
            "__raw": content_s,
            "__parse_diag": parse_diag,
            **envelope,
        }