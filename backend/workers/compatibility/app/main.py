# app/main.py
import logging
import os
import time
import json
from requests import HTTPError, Timeout, ConnectionError

from azure.servicebus.exceptions import ServiceBusError

from .config import load_settings
from .logging_setup import setup_logging
from .sb import make_client, parse_request_message
from .gateway import GatewayClient
#from .ollama_client import OllamaClient
from .llama_cpp_client import LlamaCppClient
from .compatibility import build_prompt, normalize_result
from .stats import Stats

MAX_DEBUG_CHARS = int(os.getenv("MAX_DEBUG_CHARS", "10000"))

RETRYABLE_STATUSES = {500, 502, 503, 504}

FORMAT_SCHEMA = {
    "type": "object",
    "properties": {
        "score": {"type": "number"},
        "summary": {"type": "string"},
    },
    "required": ["score", "summary"],
    "additionalProperties": False,
}

def _http_status(e: Exception) -> int | None:
    resp = getattr(e, "response", None)
    return getattr(resp, "status_code", None)

def _resp_text(e: Exception, limit: int = 1000) -> str:
    resp = getattr(e, "response", None)
    if resp is None:
        return ""
    try:
        return (resp.text or "")[:limit]
    except Exception:
        return ""

def _truncate(s: str) -> str:
    return s if len(s) <= MAX_DEBUG_CHARS else s[:MAX_DEBUG_CHARS] + "...<truncated>"

def _sb_body_to_str(msg) -> str:
    """
    ServiceBusReceivedMessage.body can be:
      - bytes
      - iterable of bytes chunks
      - already a string (rare)
    We want a debug-friendly string without crashing.
    """
    try:
        body = msg.body
        if body is None:
            return ""
        if isinstance(body, (bytes, bytearray)):
            return body.decode("utf-8", errors="replace")
        if isinstance(body, str):
            return body
        # Assume iterable of chunks
        chunks = []
        for part in body:
            if isinstance(part, (bytes, bytearray)):
                chunks.append(part.decode("utf-8", errors="replace"))
            else:
                chunks.append(str(part))
        return "".join(chunks)
    except Exception as e:
        return f"<failed to read body: {e}>"

def main() -> None:
    setup_logging()
    s = load_settings("/app/config.yaml")

    log = logging.getLogger("compat-worker")
    log.info(
        "Starting worker enricherType=%s queue=%s gateway=%s llama_cpp=%s model=%s",
        s.enricher_type, s.sb_queue, s.gateway_base_url, s.llama_cpp_base_url, s.model
    )

    stats = Stats()
    log.info("Worker stats path=%s", os.getenv("WORKER_STATS_PATH", "/tmp/worker_stats.json"))

    gw = GatewayClient(s.gateway_base_url, s.gateway_api_key)
    llm = LlamaCppClient(s.llama_cpp_base_url)
    sb = make_client(s.sb_conn_str)

    # Flush stats occasionally even if idle
    last_flush = time.time()

    while True:
        try:
            # Count each poll cycle (even if no message arrives)
            stats.bump("sb_polls", "sb_polls_last_at")

            with sb:
                receiver = sb.get_queue_receiver(
                    queue_name=s.sb_queue,
                    max_wait_time=s.poll_wait_seconds,
                    max_auto_lock_renewal_duration=600,  # seconds (10 min)
                )
                with receiver:
                    msgs = receiver.receive_messages(max_message_count=1, max_wait_time=s.poll_wait_seconds)

                    # periodic flush when idle
                    if time.time() - last_flush > 10:
                        stats.flush()
                        last_flush = time.time()

                    if not msgs:
                        continue

                    msg = msgs[0]
                    if log.isEnabledFor(logging.DEBUG):
                        sb_body = _sb_body_to_str(msg)
                        log.debug(
                            "SB msg received id=%s seq=%s subject=%s content_type=%s enqueued=%s delivery_count=%s body=%s",
                            getattr(msg, "message_id", None),
                            getattr(msg, "sequence_number", None),
                            getattr(msg, "subject", None),
                            getattr(msg, "content_type", None),
                            getattr(msg, "enqueued_time_utc", None),
                            getattr(msg, "delivery_count", None),
                            _truncate(sb_body),
                        )                    
                    stats.bump("sb_messages", "sb_messages_last_at")
                    stats.flush()
                    last_flush = time.time()

                    parsed = parse_request_message(msg)
                    if not parsed:
                        log.warning("Bad message body; dead-lettering msgId=%s", msg.message_id)
                        receiver.dead_letter_message(msg, reason="BadMessage", error_description="JSON parse failed")
                        # Consider this an error for ops visibility
                        stats.error()
                        stats.flush()
                        continue

                    # Do not consume other enrichers
                    if parsed.enricher_type != s.enricher_type:
                        log.info(
                            "Ignoring other enricherType=%s msgId=%s; abandoning",
                            parsed.enricher_type, msg.message_id
                        )
                        receiver.abandon_message(msg)
                        stats.bump("other_enricher_abandoned", "other_enricher_last_at")
                        stats.flush()
                        time.sleep(s.backoff_seconds)
                        continue

                    if not parsed.run_id:
                        log.warning("Missing runId; dead-lettering msgId=%s", msg.message_id)
                        receiver.dead_letter_message(msg, reason="BadMessage", error_description="Missing runId")
                        stats.error()
                        stats.flush()
                        continue

                    # Lease from gateway
                    log.info("Leasing runId=%s subjectKey=%s", parsed.run_id, parsed.subject_key)

                    if log.isEnabledFor(logging.DEBUG):
                        lease_req = {"runId": parsed.run_id, "ttlSeconds": s.lease_ttl_seconds}
                        log.debug("Gateway /lease request %s",
                                _truncate(json.dumps(lease_req, ensure_ascii=False, separators=(",", ":"))))

                    try:
                        lease = gw.lease(parsed.run_id, s.lease_ttl_seconds)
                    except HTTPError as e:
                        # Treat 409 as "lease refused / conflict" -> consume SB message and move on
                        resp = getattr(e, "response", None)
                        status = getattr(resp, "status_code", None)

                        if status == 409:
                            # try to capture any body text for diagnosis
                            body = ""
                            try:
                                body = (resp.text or "")[:1000] if resp is not None else ""
                            except Exception:
                                body = ""

                            log.info(
                                "Lease conflict (409) runId=%s msgId=%s; completing SB message. body=%s",
                                parsed.run_id, msg.message_id, _truncate(body)
                            )
                            receiver.complete_message(msg)
                            stats.bump("lease_conflict_409", "lease_conflict_last_at")
                            stats.flush()
                            # small backoff to avoid hammering gateway if many conflicts
                            time.sleep(min(1, s.backoff_seconds))
                            continue

                        # other HTTP errors are real failures
                        raise

                    if log.isEnabledFor(logging.DEBUG):
                        try:
                            lease_json = json.dumps(lease, ensure_ascii=False, separators=(",", ":"))
                        except TypeError:
                            lease_json = json.dumps({"lease": str(lease)}, ensure_ascii=False, separators=(",", ":"))
                        log.debug("Gateway /lease response %s", _truncate(lease_json))

                        # Quick targeted visibility (helps spot wrong keys)
                        input_obj_dbg = (lease or {}).get("input") or {}
                        job_dbg = input_obj_dbg.get("job") or {}
                        cv_dbg = input_obj_dbg.get("cv")
                        log.debug(
                            "Lease input keys=%s jobKeys=%s cvLen=%s",
                            list(input_obj_dbg.keys()) if isinstance(input_obj_dbg, dict) else type(input_obj_dbg).__name__,
                            list(job_dbg.keys()) if isinstance(job_dbg, dict) else type(job_dbg).__name__,
                            (len(cv_dbg) if isinstance(cv_dbg, str) else (0 if cv_dbg is None else len(str(cv_dbg))))
                        )

                    lease_token = str(lease.get("leaseToken") or "")
                    if not lease_token:
                        # e.g. superseded / not latest / not found
                        log.info(
                            "Lease refused for runId=%s; completing SB msgId=%s",
                            parsed.run_id, msg.message_id
                        )
                        receiver.complete_message(msg)
                        stats.bump("lease_refused", "lease_refused_last_at")
                        stats.flush()
                        continue

                    stats.bump("leases_ok", "leases_ok_last_at")
                    stats.flush()

                    # Expect inline input snapshot (keep v1 simple)
                    input_obj = lease.get("input") or {}
                    job = input_obj.get("job") or {}
                    cv_text = str(input_obj.get("cv") or "")
                    if log.isEnabledFor(logging.DEBUG):
                        log.debug("Prompt inputs jobKeys=%s cvTextLen=%s",
                                list(job.keys()) if isinstance(job, dict) else type(job).__name__,
                                len(cv_text))                    

                    prompt = build_prompt(job=job, cv_text=cv_text)

                    # Inference
                    log.info("Running inference runId=%s model=%s", parsed.run_id, s.model)

                    # Helper to centralize llama.cpp calls
                    def _llm_call(*, num_predict, use_schema: bool):
                        return llm.generate_json(
                            model=s.model,
                            prompt=prompt,
                            system=s.system_prompt,
                            temperature=s.temperature,
                            top_p=s.top_p,
                            top_k=getattr(s, "top_k", None),
                            min_p=getattr(s, "min_p", None),
                            presence_penalty=getattr(s, "presence_penalty", None),
                            repetition_penalty=getattr(s, "repetition_penalty", None),
                            format=(FORMAT_SCHEMA if use_schema else None),
                            # keep old config compatibility
                            num_predict=num_predict,
                        )

                    def _status_from_exc(e: Exception):
                        resp = getattr(e, "response", None)
                        return getattr(resp, "status_code", None)

                    def _body_from_exc(e: Exception, limit: int = 1000) -> str:
                        resp = getattr(e, "response", None)
                        if resp is None:
                            return ""
                        try:
                            return (resp.text or "")[:limit]
                        except Exception:
                            return ""

                    max_tokens_1 = getattr(s, "max_tokens", None)
                    # Retry with a smaller budget (compatibility output is small)
                    if isinstance(max_tokens_1, int) and max_tokens_1 > 256:
                        max_tokens_2 = 256
                    elif max_tokens_1 is None:
                        max_tokens_2 = 256
                    else:
                        max_tokens_2 = max_tokens_1

                    try:
                        # Attempt 1: schema-enabled
                        raw = _llm_call(num_predict=max_tokens_1, use_schema=True)

                        if log.isEnabledFor(logging.DEBUG):
                            try:
                                raw_json = json.dumps(raw, ensure_ascii=False, separators=(",", ":"))
                            except TypeError:
                                raw_json = json.dumps({"raw": str(raw)}, ensure_ascii=False, separators=(",", ":"))
                            log.debug("llama.cpp response %s", raw_json)

                        # Fallback: empty response while schema enabled -> retry without schema (your existing behavior)
                        if raw.get("__parse_error") == "empty_response":
                            log.warning(
                                "llama.cpp returned empty response with schema; retrying without schema runId=%s llama_cpp=%s model=%s",
                                parsed.run_id, s.llama_cpp_base_url, s.model
                            )
                            raw = _llm_call(num_predict=max_tokens_1, use_schema=False)

                            if log.isEnabledFor(logging.DEBUG):
                                try:
                                    raw_json = json.dumps(raw, ensure_ascii=False, separators=(",", ":"))
                                except TypeError:
                                    raw_json = json.dumps({"raw": str(raw)}, ensure_ascii=False, separators=(",", ":"))
                                log.debug("llama.cpp response %s", raw_json)

                    except (HTTPError, Timeout, ConnectionError) as e:
                        status = _status_from_exc(e)
                        body = _truncate(_body_from_exc(e))

                        retryable = (status in (500, 502, 503, 504)) or isinstance(e, (Timeout, ConnectionError))

                        log.error(
                            "Inference failed runId=%s status=%s retryable=%s body=%s",
                            parsed.run_id, status, retryable, body
                        )
                        stats.bump("llm_errors", "llm_errors_last_at")
                        if status == 500:
                            stats.bump("llm_http_500", "llm_http_500_last_at")
                        stats.flush()

                        if retryable:
                            # Attempt 2: smaller tokens, no schema (less memory pressure / fewer moving parts)
                            try:
                                log.warning(
                                    "Retrying inference once runId=%s max_tokens=%s (no schema)",
                                    parsed.run_id, max_tokens_2
                                )
                                raw = _llm_call(num_predict=max_tokens_2, use_schema=False)

                                if log.isEnabledFor(logging.DEBUG):
                                    try:
                                        raw_json = json.dumps(raw, ensure_ascii=False, separators=(",", ":"))
                                    except TypeError:
                                        raw_json = json.dumps({"raw": str(raw)}, ensure_ascii=False, separators=(",", ":"))
                                    log.debug("llama.cpp response %s", raw_json)

                            except Exception as e2:
                                status2 = _status_from_exc(e2)
                                body2 = _truncate(_body_from_exc(e2))

                                log.error(
                                    "Inference retry failed runId=%s status=%s body=%s",
                                    parsed.run_id, status2, body2
                                )
                                stats.bump("llm_retries_failed", "llm_retries_failed_last_at")
                                stats.flush()

                                # Close out the run so it doesn't stay leased for TTL
                                fail_result = {
                                    "score": 0.0,
                                    "summary": f"Inference failed (status={status2}). {body2}".strip()
                                }
                                log.info("Completing run as failed runId=%s", parsed.run_id)
                                gw.complete(parsed.run_id, lease_token, fail_result)
                                stats.bump("completes_failed", "completes_failed_last_at")
                                stats.flush()

                                receiver.complete_message(msg)
                                continue
                        else:
                            # Non-retryable: close out immediately
                            fail_result = {
                                "score": 0.0,
                                "summary": f"Inference failed (status={status}). {body}".strip()
                            }
                            log.info("Completing run as failed runId=%s", parsed.run_id)
                            gw.complete(parsed.run_id, lease_token, fail_result)
                            stats.bump("completes_failed", "completes_failed_last_at")
                            stats.flush()

                            receiver.complete_message(msg)
                            continue

                    # At this point, we have `raw` from either:
                    # - attempt 1
                    # - empty_response fallback
                    # - retry path
                    result = normalize_result(raw)

                    # Submit back
                    log.info("Completing runId=%s score=%s", parsed.run_id, result.get("score"))
                    gw.complete(parsed.run_id, lease_token, result)

                    stats.bump("completes_ok", "completes_ok_last_at")
                    stats.flush()

                    # Only now consume SB message
                    receiver.complete_message(msg)

        except ServiceBusError as e:
            logging.exception("Service Bus error: %s", e)
            stats.error()
            stats.flush()
            time.sleep(5)
        except Exception as e:
            logging.exception("Unexpected error: %s", e)
            stats.error()
            stats.flush()
            time.sleep(5)


if __name__ == "__main__":
    main()