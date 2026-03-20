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
from .llama_cpp_client import LlamaCppClient
from .compatibility import build_prompt, normalize_result
from .stats import Stats

MAX_DEBUG_CHARS = int(os.getenv("MAX_DEBUG_CHARS", "10000"))

# 400 kept temporarily because fallback/no-thinking retry can recover
RETRYABLE_STATUSES = {400, 500, 502, 503, 504}


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
    log.info(
        "LLM effective settings temperature=%s top_p=%s top_k=%s min_p=%s presence_penalty=%s repetition_penalty=%s max_tokens=%s",
        s.temperature,
        s.top_p,
        getattr(s, "top_k", None),
        getattr(s, "min_p", None),
        getattr(s, "presence_penalty", None),
        getattr(s, "repetition_penalty", None),
        getattr(s, "max_tokens", None),
    )

    stats = Stats()
    log.info("Worker stats path=%s", os.getenv("WORKER_STATS_PATH", "/tmp/worker_stats.json"))

    gw = GatewayClient(s.gateway_base_url, s.gateway_api_key)
    llm = LlamaCppClient(s.llama_cpp_base_url)
    sb = make_client(s.sb_conn_str)

    last_flush = time.time()

    while True:
        try:
            stats.bump("sb_polls", "sb_polls_last_at")

            with sb:
                receiver = sb.get_queue_receiver(
                    queue_name=s.sb_queue,
                    max_wait_time=s.poll_wait_seconds,
                    max_auto_lock_renewal_duration=600,
                )
                with receiver:
                    msgs = receiver.receive_messages(max_message_count=1, max_wait_time=s.poll_wait_seconds)

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
                        stats.error()
                        stats.flush()
                        continue

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

                    log.info("Leasing runId=%s subjectKey=%s", parsed.run_id, parsed.subject_key)

                    if log.isEnabledFor(logging.DEBUG):
                        lease_req = {"runId": parsed.run_id, "ttlSeconds": s.lease_ttl_seconds}
                        log.debug(
                            "Gateway /lease request %s",
                            _truncate(json.dumps(lease_req, ensure_ascii=False, separators=(",", ":"))),
                        )

                    try:
                        lease = gw.lease(parsed.run_id, s.lease_ttl_seconds)
                    except HTTPError as e:
                        resp = getattr(e, "response", None)
                        status = getattr(resp, "status_code", None)

                        if status == 409:
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
                            time.sleep(min(1, s.backoff_seconds))
                            continue

                        raise

                    if log.isEnabledFor(logging.DEBUG):
                        try:
                            lease_json = json.dumps(lease, ensure_ascii=False, separators=(",", ":"))
                        except TypeError:
                            lease_json = json.dumps({"lease": str(lease)}, ensure_ascii=False, separators=(",", ":"))
                        log.debug("Gateway /lease response %s", _truncate(lease_json))

                        input_obj_dbg = (lease or {}).get("input") or {}
                        job_dbg = input_obj_dbg.get("job") or {}
                        cv_dbg = input_obj_dbg.get("cv")
                        log.debug(
                            "Lease input keys=%s jobKeys=%s cvLen=%s",
                            list(input_obj_dbg.keys()) if isinstance(input_obj_dbg, dict) else type(input_obj_dbg).__name__,
                            list(job_dbg.keys()) if isinstance(job_dbg, dict) else type(job_dbg).__name__,
                            (len(cv_dbg) if isinstance(cv_dbg, str) else (0 if cv_dbg is None else len(str(cv_dbg)))),
                        )

                    lease_token = str(lease.get("leaseToken") or "")
                    if not lease_token:
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

                    input_obj = lease.get("input") or {}
                    job = input_obj.get("job") or {}
                    cv_obj = input_obj.get("cv") or {}
                    if isinstance(cv_obj, dict):
                        cv_text = str(cv_obj.get("text") or "")
                    else:
                        cv_text = str(cv_obj or "")

                    if log.isEnabledFor(logging.DEBUG):
                        log.debug(
                            "Prompt inputs jobKeys=%s cvTextLen=%s",
                            list(job.keys()) if isinstance(job, dict) else type(job).__name__,
                            len(cv_text),
                        )

                    prompt = build_prompt(job=job, cv_text=cv_text)

                    log.info("Running inference runId=%s model=%s", parsed.run_id, s.model)

                    attempt_meta = {
                        "fallback_no_thinking": False,
                        "attempts": 0,
                    }

                    def _llm_call(*, num_predict, system_override: str | None = None):
                        return llm.generate_json(
                            model=s.model,
                            prompt=prompt,
                            system=system_override if system_override is not None else s.system_prompt,
                            temperature=s.temperature,
                            top_p=s.top_p,
                            top_k=getattr(s, "top_k", None),
                            min_p=getattr(s, "min_p", None),
                            presence_penalty=getattr(s, "presence_penalty", None),
                            repetition_penalty=getattr(s, "repetition_penalty", None),
                            format=None,  # schema removed intentionally
                            num_predict=num_predict,
                        )

                    def _status_from_exc(e: Exception):
                        resp = getattr(e, "response", None)
                        return getattr(resp, "status_code", None)

                    def _body_from_exc(e: Exception, limit: int = 1000) -> str:
                        body = getattr(e, "_llama_cpp_body", None)
                        if isinstance(body, str) and body:
                            return body[:limit]

                        resp = getattr(e, "response", None)
                        if resp is None:
                            return ""
                        try:
                            return (resp.text or "")[:limit]
                        except Exception:
                            return ""

                    def _debug_from_exc(e: Exception):
                        dbg = getattr(e, "_llama_cpp_debug", None)
                        return dbg if isinstance(dbg, dict) else None

                    max_tokens_1 = getattr(s, "max_tokens", None)
                    if not isinstance(max_tokens_1, int) or max_tokens_1 <= 0:
                        max_tokens_1 = 1024

                    max_tokens_2 = max(max_tokens_1, 2048)

                    retry_system = (
                        s.system_prompt.rstrip()
                        + "\n\nIMPORTANT OVERRIDE:\n"
                          "Do not output reasoning, thought process, analysis, or <think> blocks.\n"
                          "Return only the final JSON object.\n"
                          "Start your response with '{' and end it with '}'."
                    )

                    try:
                        attempt_meta["attempts"] = 1
                        raw = _llm_call(num_predict=max_tokens_1)

                        if log.isEnabledFor(logging.DEBUG):
                            try:
                                raw_json = json.dumps(raw, ensure_ascii=False, separators=(",", ":"))
                            except TypeError:
                                raw_json = json.dumps({"raw": str(raw)}, ensure_ascii=False, separators=(",", ":"))
                            log.debug("llama.cpp response %s", raw_json)

                    except (HTTPError, Timeout, ConnectionError) as e:
                        status = _status_from_exc(e)
                        body = _truncate(_body_from_exc(e))
                        retryable = (status in RETRYABLE_STATUSES) or isinstance(e, (Timeout, ConnectionError))

                        dbg = _debug_from_exc(e)
                        log.error(
                            "Inference failed runId=%s status=%s retryable=%s body=%s debug=%s",
                            parsed.run_id, status, retryable, body, dbg
                        )
                        stats.bump("llm_errors", "llm_errors_last_at")
                        if status == 500:
                            stats.bump("llm_http_500", "llm_http_500_last_at")
                        stats.flush()

                        if retryable:
                            try:
                                attempt_meta["attempts"] = 2
                                attempt_meta["fallback_no_thinking"] = True
                                log.warning(
                                    "Retrying inference once runId=%s max_tokens=%s (no thinking override)",
                                    parsed.run_id, max_tokens_2
                                )

                                raw = _llm_call(
                                    num_predict=max_tokens_2,
                                    system_override=retry_system,
                                )

                                if log.isEnabledFor(logging.DEBUG):
                                    try:
                                        raw_json = json.dumps(raw, ensure_ascii=False, separators=(",", ":"))
                                    except TypeError:
                                        raw_json = json.dumps({"raw": str(raw)}, ensure_ascii=False, separators=(",", ":"))
                                    log.debug("llama.cpp response %s", raw_json)

                            except Exception as e2:
                                status2 = _status_from_exc(e2)
                                body2 = _truncate(_body_from_exc(e2))
                                dbg2 = _debug_from_exc(e2)

                                log.error(
                                    "Inference retry failed runId=%s status=%s body=%s debug=%s",
                                    parsed.run_id, status2, body2, dbg2
                                )
                                stats.bump("llm_retries_failed", "llm_retries_failed_last_at")
                                stats.flush()

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

                    result = normalize_result(raw)

                    summary = str(result.get("summary") or "")
                    markers = []

                    if attempt_meta.get("fallback_no_thinking"):
                        markers.append("degraded: retry used no-thinking override")

                    parse_diag = raw.get("__parse_diag") if isinstance(raw, dict) else None
                    if isinstance(parse_diag, dict):
                        if parse_diag.get("had_think_block"):
                            markers.append("degraded: stripped think block from model output")
                        if parse_diag.get("used_json_extraction"):
                            markers.append("degraded: extracted JSON from mixed output")

                    if markers:
                        if summary:
                            summary = f"{summary} [diagnostics] " + " | ".join(markers)
                        else:
                            summary = "[diagnostics] " + " | ".join(markers)
                        result["summary"] = summary

                    log.info("Completing runId=%s score=%s", parsed.run_id, result.get("score"))
                    gw.complete(parsed.run_id, lease_token, result)

                    stats.bump("completes_ok", "completes_ok_last_at")
                    stats.flush()

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