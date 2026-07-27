# app/main.py
import logging
import os
import time
import json
from requests import HTTPError

from azure.servicebus.exceptions import ServiceBusError

from .config import load_settings
from .logging_setup import setup_logging
from .sb import make_client, parse_request_message
from .gateway import GatewayClient
from .llama_cpp_client import LlamaCppClient
from .compatibility import (
    build_prompt,
    normalize_result,
    evaluate_language_disqualification,
    calculate_final_score,
)
from .stats import Stats
from .inference_resilience import (
    InferenceFatal,
    http_status as inference_http_status,
    run_with_outage_recovery,
)

MAX_DEBUG_CHARS = int(os.getenv("MAX_DEBUG_CHARS", "10000"))


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
    llm = LlamaCppClient(
        s.llama_cpp_base_url,
        timeout_s=s.inference_timeout_seconds,
    )
    sb = make_client(s.sb_conn_str)

    last_flush = time.time()

    while True:
        try:
            stats.bump("sb_polls", "sb_polls_last_at")

            with sb:
                receiver = sb.get_queue_receiver(
                    queue_name=s.sb_queue,
                    max_wait_time=s.poll_wait_seconds,
                    max_auto_lock_renewal_duration=s.message_lock_renewal_seconds,
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
                        "degraded": False,
                        "degraded_reason": "",
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
                            num_predict=num_predict,
                            format=None,  # schema removed intentionally
                            # llama.cpp / Qwen thinking controls
                            enable_thinking=s.enable_thinking,
                            thinking_budget_tokens=s.thinking_budget_tokens,
                            reasoning_format=s.reasoning_format,                            
                        )

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
                        max_tokens_1 = 1200

                    max_tokens_2 = max(max_tokens_1, 2200)

                    retry_system = (
                        s.system_prompt.rstrip()
                        + "\n\nIMPORTANT OVERRIDE:\n"
                          "Do not output reasoning, thought process, analysis, or <think> blocks.\n"
                          "Return only the final JSON object.\n"
                          "Start your response with '{' and end it with '}'."
                    )

                    def _primary_call():
                        return _llm_call(num_predict=max_tokens_1)

                    def _fallback_call():
                        return _llm_call(
                            num_predict=max_tokens_2,
                            system_override=retry_system,
                        )

                    def _on_attempt_error(exc: BaseException, attempt: int, will_retry: bool):
                        status = inference_http_status(exc)
                        body = _body_from_exc(exc)
                        dbg = _debug_from_exc(exc)
                        debug_keys = sorted(dbg.keys()) if isinstance(dbg, dict) else []
                        log.error(
                            "Inference attempt failed runId=%s attempt=%s status=%s will_retry=%s error_type=%s body_len=%s debug_keys=%s",
                            parsed.run_id,
                            attempt,
                            status,
                            will_retry,
                            type(exc).__name__,
                            len(body),
                            debug_keys,
                        )
                        stats.bump("llm_errors", "llm_errors_last_at")
                        if status == 500:
                            stats.bump("llm_http_500", "llm_http_500_last_at")
                        stats.flush()

                    def _release_unavailable(active_lease_token: str, message: str):
                        log.warning(
                            "Returning run to Queued after inference outage runId=%s",
                            parsed.run_id,
                        )
                        gw.complete_error(
                            parsed.run_id,
                            active_lease_token,
                            code="INFERENCE_UNAVAILABLE",
                            message=message,
                        )
                        stats.bump("inference_runs_requeued", "inference_runs_requeued_last_at")
                        stats.flush()

                    def _reacquire_lease() -> str:
                        log.info("Re-leasing recovered runId=%s", parsed.run_id)
                        renewed = gw.lease(parsed.run_id, s.lease_ttl_seconds)
                        token = str((renewed or {}).get("leaseToken") or "")
                        if not token:
                            raise RuntimeError("Gateway returned no lease token after inference recovery")
                        return token

                    def _on_circuit_open(exc, recovery_cycle: int):
                        log.warning(
                            "Inference circuit open runId=%s cycle=%s cooldown_seconds=%s reason=%s",
                            parsed.run_id,
                            recovery_cycle,
                            s.inference_outage_cooldown_seconds,
                            exc.public_message,
                        )
                        stats.bump("inference_circuit_opened", "inference_circuit_opened_last_at")
                        stats.flush()

                    def _on_health_probe(healthy: bool, probe_number: int):
                        log.info(
                            "Inference health probe runId=%s probe=%s healthy=%s",
                            parsed.run_id,
                            probe_number,
                            healthy,
                        )
                        stats.bump("inference_health_probes", "inference_health_probes_last_at")
                        if healthy:
                            stats.bump("inference_health_recovered", "inference_health_recovered_last_at")
                        stats.flush()

                    try:
                        recovery = run_with_outage_recovery(
                            initial_lease_token=lease_token,
                            primary_call=_primary_call,
                            fallback_call=_fallback_call,
                            release_unavailable=_release_unavailable,
                            reacquire_lease=_reacquire_lease,
                            health_check=lambda: llm.is_healthy(
                                timeout_s=s.inference_health_timeout_seconds
                            ),
                            retry_delays_seconds=s.inference_retry_delays_seconds,
                            outage_cooldown_seconds=s.inference_outage_cooldown_seconds,
                            on_attempt_error=_on_attempt_error,
                            on_circuit_open=_on_circuit_open,
                            on_health_probe=_on_health_probe,
                        )
                    except InferenceFatal as exc:
                        log.error(
                            "Terminal inference failure runId=%s code=%s message=%s",
                            parsed.run_id,
                            exc.code,
                            exc.public_message,
                        )
                        gw.complete_error(
                            parsed.run_id,
                            exc.lease_token,
                            code=exc.code,
                            message=exc.public_message,
                        )
                        stats.bump("completes_failed", "completes_failed_last_at")
                        stats.flush()
                        receiver.complete_message(msg)
                        continue

                    raw = recovery.raw
                    lease_token = recovery.lease_token
                    attempt_meta["attempts"] = recovery.attempts
                    attempt_meta["fallback_no_thinking"] = recovery.used_fallback
                    attempt_meta["degraded"] = bool(
                        recovery.used_fallback or recovery.recovery_cycles
                    )
                    attempt_meta["degraded_reason"] = recovery.degraded_reason
                    if recovery.recovery_cycles:
                        recovery_note = (
                            f"inference recovered after {recovery.recovery_cycles} outage cycle(s)"
                        )
                        if attempt_meta["degraded_reason"]:
                            attempt_meta["degraded_reason"] += "; " + recovery_note
                        else:
                            attempt_meta["degraded_reason"] = recovery_note
                    if log.isEnabledFor(logging.DEBUG):
                        try:
                            raw_json = json.dumps(raw, ensure_ascii=False, separators=(",", ":"))
                        except TypeError:
                            raw_json = json.dumps({"raw": str(raw)}, ensure_ascii=False, separators=(",", ":"))
                        log.debug("llama.cpp response %s", _truncate(raw_json))

                    structured = normalize_result(raw)

                    description = str(structured.get("description") or "")
                    languages = structured.get("languages") or {}
                    hard_skills = structured.get("hard_skills") or {}
                    experience = structured.get("experience") or {}
                    soft_skills = structured.get("soft_skills") or {}

                    hard_score = float(hard_skills.get("score") or 0.0)
                    exp_score = float(experience.get("score") or 0.0)
                    soft_score = float(soft_skills.get("score") or 0.0)

                    lang_eval = evaluate_language_disqualification(languages)
                    final_score = calculate_final_score(
                        hard_skills_score=hard_score,
                        experience_score=exp_score,
                        soft_skills_score=soft_score,
                        language_disqualified=bool(lang_eval.get("disqualified")),
                    )

                    if log.isEnabledFor(logging.DEBUG):
                        log.debug(
                            "Structured LLM result runId=%s description=%s languages=%s hard_skills=%s experience=%s soft_skills=%s",
                            parsed.run_id,
                            _truncate(json.dumps(description, ensure_ascii=False)),
                            _truncate(json.dumps(languages, ensure_ascii=False, separators=(",", ":"))),
                            _truncate(json.dumps(hard_skills, ensure_ascii=False, separators=(",", ":"))),
                            _truncate(json.dumps(experience, ensure_ascii=False, separators=(",", ":"))),
                            _truncate(json.dumps(soft_skills, ensure_ascii=False, separators=(",", ":"))),
                        )
                        log.debug(
                            "Calculated compatibility runId=%s hard_score=%.1f experience_score=%.1f soft_score=%.1f language_disqualified=%s language_eval=%s final_score=%.1f",
                            parsed.run_id,
                            hard_score,
                            exp_score,
                            soft_score,
                            bool(lang_eval.get("disqualified")),
                            _truncate(json.dumps(lang_eval, ensure_ascii=False, separators=(",", ":"))),
                            final_score,
                        )

                    summary = description
                    diagnostics = []

                    if attempt_meta.get("degraded"):
                        degraded_reason = str(attempt_meta.get("degraded_reason") or "").strip()
                        if degraded_reason:
                            diagnostics.append(f"degraded: {degraded_reason}")
                        else:
                            diagnostics.append("degraded: inference used fallback path")

                    if bool(lang_eval.get("disqualified")):
                        missing = lang_eval.get("missing") or []
                        if isinstance(missing, list) and missing:
                            missing_parts = []
                            for item in missing:
                                if not isinstance(item, dict):
                                    continue
                                lang = str(item.get("Language") or "").strip()
                                required = str(item.get("Required") or "").strip()
                                actual = item.get("Applicant")
                                actual_s = str(actual).strip() if actual is not None else "absent"

                                if lang and required:
                                    missing_parts.append(f"{lang} required {required}, applicant {actual_s}")
                                elif lang:
                                    missing_parts.append(f"{lang} applicant {actual_s}")

                            if missing_parts:
                                diagnostics.append(
                                    "score forced to 0.5 due to mandatory language mismatch: " + "; ".join(missing_parts)
                                )
                            else:
                                diagnostics.append("score forced to 0.5 due to mandatory language mismatch")

                    if diagnostics:
                        if summary:
                            summary = f"{summary} [diagnostics] " + " | ".join(diagnostics)
                        else:
                            summary = "[diagnostics] " + " | ".join(diagnostics)



                    result = {
                        "score": final_score,
                        "summary": summary,
                    }

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