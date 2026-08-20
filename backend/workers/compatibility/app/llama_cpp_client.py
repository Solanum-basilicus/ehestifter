# /app/llama_cpp_client.py
import json
import re
import hashlib
import logging
import requests
from typing import Any, Dict, Iterator, Optional, Tuple


REASONING_CONTROL_FALLBACK_MARGIN_TOKENS = 50


class LlamaCppProtocolError(requests.RequestException):
    """The llama.cpp response stream did not follow the expected protocol."""


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

    @staticmethod
    def _iter_sse_data(response: requests.Response) -> Iterator[str]:
        """Yield complete SSE data fields from a llama.cpp response."""
        data_lines: list[str] = []

        # Use one-byte chunks so requests does not wait for a larger buffer.
        for raw_line in response.iter_lines(chunk_size=1, decode_unicode=True):
            if isinstance(raw_line, bytes):
                line = raw_line.decode("utf-8", errors="strict")
            else:
                line = str(raw_line)

            if line == "":
                if data_lines:
                    yield "\n".join(data_lines)
                    data_lines = []
                continue

            if line.startswith(":"):
                continue
            if line.startswith("data:"):
                value = line[5:]
                if value.startswith(" "):
                    value = value[1:]
                data_lines.append(value)
                continue
            if line.startswith(("event:", "id:", "retry:")):
                continue

            # Ignore extension fields. JSON data still must use the data field.
            continue

        if data_lines:
            yield "\n".join(data_lines)

    def _send_reasoning_end(self, *, completion_id: str, model: str) -> Optional[str]:
        """Send one reasoning-end control request and return an error message."""
        control_url = f"{self.base_url}/v1/chat/completions/control"
        try:
            response = self.session.post(
                control_url,
                json={
                    "id": completion_id,
                    "action": "reasoning_end",
                    "model": model,
                },
                headers={"Content-Type": "application/json", "Accept": "application/json"},
                timeout=(2, min(10, self.timeout_s)),
            )
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, dict):
                return "control response was not a JSON object"
            if data.get("success") is not True:
                message = data.get("message")
                return f"control response reported failure: {message or 'no message'}"
            return None
        except requests.RequestException as exc:
            return f"control request failed: {type(exc).__name__}: {exc}"
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            return f"control response was invalid: {type(exc).__name__}: {exc}"
        except Exception as exc:
            return f"control request failed: {type(exc).__name__}: {exc}"

    def _read_budgeted_stream(
        self,
        *,
        response: requests.Response,
        model: str,
        budget_tokens: int,
    ) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        """Read one chat SSE stream and apply the reasoning control fallback."""
        completion_id: Optional[str] = None
        response_model: Optional[str] = None
        created: Any = None
        finish_reason: Any = None
        usage: Any = None
        timings: Any = None
        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        final_content_started = False
        saw_finish_reason = False
        reasoning_control_attempted = False
        reasoning_control_error: Optional[str] = None
        last_predicted_n: Optional[int] = None
        fallback_tokens = budget_tokens + REASONING_CONTROL_FALLBACK_MARGIN_TOKENS

        for event_data in self._iter_sse_data(response):
            if event_data.strip() == "[DONE]":
                break

            try:
                chunk = json.loads(event_data)
            except (TypeError, ValueError, json.JSONDecodeError) as exc:
                raise LlamaCppProtocolError(f"invalid SSE JSON: {exc}") from exc
            if not isinstance(chunk, dict):
                raise LlamaCppProtocolError("SSE data was not a JSON object")

            chunk_id = chunk.get("id")
            if chunk_id:
                if completion_id is not None and chunk_id != completion_id:
                    raise LlamaCppProtocolError("completion id changed in the SSE stream")
                completion_id = str(chunk_id)

            if chunk.get("model") is not None:
                response_model = str(chunk.get("model"))
            if created is None and chunk.get("created") is not None:
                created = chunk.get("created")
            if chunk.get("usage") is not None:
                usage = chunk.get("usage")
            if chunk.get("timings") is not None:
                timings = chunk.get("timings")

            predicted_n = None
            chunk_timings = chunk.get("timings")
            if isinstance(chunk_timings, dict):
                try:
                    predicted_n = int(chunk_timings.get("predicted_n"))
                except (TypeError, ValueError):
                    predicted_n = None
            if predicted_n is not None:
                last_predicted_n = predicted_n

            choices = chunk.get("choices")
            if not isinstance(choices, list) or not choices:
                continue
            choice0 = choices[0]
            if not isinstance(choice0, dict):
                raise LlamaCppProtocolError("SSE choice was not a JSON object")

            delta = choice0.get("delta") or {}
            if not isinstance(delta, dict):
                raise LlamaCppProtocolError("SSE delta was not a JSON object")

            reasoning_delta = delta.get("reasoning_content")
            if reasoning_delta is not None:
                reasoning_s = str(reasoning_delta)
                if reasoning_s:
                    reasoning_parts.append(reasoning_s)

            content_delta = delta.get("content")
            if content_delta is not None:
                content_s = str(content_delta)
                if content_s:
                    final_content_started = True
                    content_parts.append(content_s)

            if choice0.get("finish_reason") is not None:
                finish_reason = choice0.get("finish_reason")
                saw_finish_reason = True

            should_end_reasoning = (
                not reasoning_control_attempted
                and not final_content_started
                and bool(reasoning_parts)
                and completion_id is not None
                and predicted_n is not None
                and predicted_n >= fallback_tokens
            )
            if should_end_reasoning:
                reasoning_control_attempted = True
                reasoning_control_error = self._send_reasoning_end(
                    completion_id=completion_id,
                    model=model,
                )
                if reasoning_control_error:
                    self.log.warning(
                        "llama.cpp reasoning control failed id=%s error=%s",
                        completion_id,
                        reasoning_control_error,
                    )
                else:
                    self.log.info(
                        "llama.cpp reasoning fallback sent id=%s predicted_n=%s "
                        "budget=%s fallback=%s",
                        completion_id,
                        predicted_n,
                        budget_tokens,
                        fallback_tokens,
                    )

        if not saw_finish_reason:
            raise LlamaCppProtocolError("SSE stream ended before a finish reason")

        data: Dict[str, Any] = {
            "id": completion_id,
            "model": response_model or model,
            "created": created,
            "choices": [
                {
                    "message": {
                        "content": "".join(content_parts),
                        "reasoning_content": "".join(reasoning_parts),
                    },
                    "finish_reason": finish_reason,
                }
            ],
            "usage": usage,
            "timings": timings,
        }
        stream_diag: Dict[str, Any] = {
            "reasoning_budget_tokens": budget_tokens,
            "reasoning_control_fallback_tokens": fallback_tokens,
            "reasoning_control_attempted": reasoning_control_attempted,
            "reasoning_control_error": reasoning_control_error,
            "predicted_n": last_predicted_n,
        }
        return data, stream_diag

    def _parse_response_data(
        self,
        data: Dict[str, Any],
        *,
        extra_diag: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        msg: Dict[str, Any] = {}
        choices0: Dict[str, Any] = {}

        try:
            choices0 = (data.get("choices") or [{}])[0]
            msg = (choices0.get("message", {}) or {})
        except Exception:
            choices0 = {}
            msg = {}

        content = msg.get("content", "")
        reasoning_content = msg.get("reasoning_content", "")

        self.log.info(
            "llama.cpp response finish_reason=%s content_len=%s reasoning_len=%s usage=%s",
            choices0.get("finish_reason"),
            len(str(content or "")),
            len(str(reasoning_content or "")),
            data.get("usage"),
        )

        content_s = "" if content is None else str(content)
        envelope = self._build_envelope(data, content_s)
        envelope["__llama_cpp"]["reasoning_len"] = len(str(reasoning_content or ""))
        envelope["__llama_cpp"]["had_reasoning_content"] = bool(reasoning_content)
        if extra_diag:
            envelope["__llama_cpp"].update(extra_diag)

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

    def is_healthy(self, timeout_s: int = 5) -> bool:
        """Return True only when llama.cpp reports its model ready."""
        try:
            response = self.session.get(
                f"{self.base_url}/health",
                timeout=(min(2, timeout_s), timeout_s),
            )
            return response.status_code == 200
        except requests.RequestException:
            return False

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
        enable_thinking: Optional[bool] = None,
        thinking_budget_tokens: Optional[int] = None,
        reasoning_format: Optional[str] = None,
        format: Any = "json",
    ) -> Dict[str, Any]:
        url = f"{self.base_url}/v1/chat/completions"

        system_s = self._sanitize_text(system)
        prompt_s = self._sanitize_text(prompt)

        messages = []
        if system_s:
            messages.append({"role": "system", "content": system_s})
        messages.append({"role": "user", "content": prompt_s})

        budget_tokens = None
        if thinking_budget_tokens is not None:
            budget_tokens = int(thinking_budget_tokens)
        use_reasoning_budget = budget_tokens is not None and budget_tokens > 0

        payload: Dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": float(temperature),
            "top_p": float(top_p),
            "stream": use_reasoning_budget,
        }

        if num_predict is not None:
            payload["max_tokens"] = int(num_predict)

        if presence_penalty is not None:
            payload["presence_penalty"] = float(presence_penalty)

        if top_k is not None:
            payload["top_k"] = int(top_k)

        if min_p is not None:
            payload["min_p"] = float(min_p)

        if repetition_penalty is not None:
            payload["repeat_penalty"] = float(repetition_penalty)

        if enable_thinking is not None:
            payload["chat_template_kwargs"] = {
                "enable_thinking": bool(enable_thinking)
            }

        if reasoning_format:
            payload["reasoning_format"] = reasoning_format

        if use_reasoning_budget:
            # Use llama.cpp native per-request enforcement first. Keep streaming
            # control as a guard if the native reasoning budget does not stop.
            payload["reasoning_budget_tokens"] = budget_tokens
            payload["reasoning_control"] = True
            payload["timings_per_token"] = True

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

        headers = {
            "Content-Type": "application/json",
            "Accept": "text/event-stream" if use_reasoning_budget else "application/json",
        }

        self.log.info(
            "llama.cpp controls model=%s max_tokens=%s thinking_budget_tokens=%s "
            "reasoning_format=%s chat_template_kwargs=%s response_format=%s "
            "reasoning_budget_tokens=%s reasoning_control=%s fallback_tokens=%s",
            payload.get("model"),
            payload.get("max_tokens"),
            budget_tokens,
            payload.get("reasoning_format"),
            payload.get("chat_template_kwargs"),
            payload.get("response_format"),
            payload.get("reasoning_budget_tokens"),
            payload.get("reasoning_control", False),
            (
                budget_tokens + REASONING_CONTROL_FALLBACK_MARGIN_TOKENS
                if use_reasoning_budget
                else None
            ),
        )

        try:
            request_kwargs: Dict[str, Any] = {
                "json": payload,
                "headers": headers,
                "timeout": (10, self.timeout_s),
            }
            if use_reasoning_budget:
                request_kwargs["stream"] = True

            resp = self.session.post(url, **request_kwargs)
            resp.raise_for_status()
            if use_reasoning_budget:
                try:
                    data, stream_diag = self._read_budgeted_stream(
                        response=resp,
                        model=model,
                        budget_tokens=budget_tokens,
                    )
                finally:
                    resp.close()
                return self._parse_response_data(data, extra_diag=stream_diag)

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

        except (requests.Timeout, requests.ConnectionError, LlamaCppProtocolError):
            raise

        except requests.RequestException:
            if use_reasoning_budget:
                raise
            return {
                "__parse_error": "request_failed: invalid HTTP response",
                "__raw": "",
                "__client_debug": {"request_bytes_len": len(payload_bytes)},
            }

        except Exception as e:
            return {
                "__parse_error": f"request_failed: {e}",
                "__raw": "",
                "__client_debug": {"request_bytes_len": len(payload_bytes)},
            }

        return self._parse_response_data(data)
