# app/main.py
import logging
import os
import time
import json

from azure.servicebus.exceptions import ServiceBusError

from .config import load_settings
from .logging_setup import setup_logging
from .sb import make_client, parse_request_message
from .gateway import GatewayClient
from .ollama_client import OllamaClient
from .compatibility import build_prompt, normalize_result
from .stats import Stats

MAX_DEBUG_CHARS = int(os.getenv("MAX_DEBUG_CHARS", "10000"))

def _truncate(s: str) -> str:
    return s if len(s) <= MAX_DEBUG_CHARS else s[:MAX_DEBUG_CHARS] + "...<truncated>"

def main() -> None:
    setup_logging()
    s = load_settings("/app/config.yaml")

    log = logging.getLogger("compat-worker")
    log.info(
        "Starting worker enricherType=%s queue=%s gateway=%s ollama=%s model=%s",
        s.enricher_type, s.sb_queue, s.gateway_base_url, s.ollama_base_url, s.model
    )

    stats = Stats()
    log.info("Worker stats path=%s", os.getenv("WORKER_STATS_PATH", "/tmp/worker_stats.json"))

    gw = GatewayClient(s.gateway_base_url, s.gateway_api_key)
    oll = OllamaClient(s.ollama_base_url)
    sb = make_client(s.sb_conn_str)

    # Flush stats occasionally even if idle
    last_flush = time.time()

    while True:
        try:
            # Count each poll cycle (even if no message arrives)
            stats.bump("sb_polls", "sb_polls_last_at")

            with sb:
                receiver = sb.get_queue_receiver(queue_name=s.sb_queue, max_wait_time=s.poll_wait_seconds)
                with receiver:
                    msgs = receiver.receive_messages(max_message_count=1, max_wait_time=s.poll_wait_seconds)

                    # periodic flush when idle
                    if time.time() - last_flush > 10:
                        stats.flush()
                        last_flush = time.time()

                    if not msgs:
                        continue

                    msg = msgs[0]
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
                    lease = gw.lease(parsed.run_id, s.lease_ttl_seconds)

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
                    cv_text = str(input_obj.get("cvText") or "")

                    prompt = build_prompt(job=job, cv_text=cv_text, rubric=s.rubric)

                    # Inference
                    log.info("Running inference runId=%s model=%s", parsed.run_id, s.model)

                    if log.isEnabledFor(logging.DEBUG):
                        req_payload = {
                            "runId": parsed.run_id,
                            "model": s.model,
                            "system": s.system_prompt,
                            "prompt": prompt,
                            "temperature": s.temperature,
                            "top_p": s.top_p,
                        }
                        log.debug("Ollama request %s",
                                _truncate(json.dumps(req_payload, ensure_ascii=False, separators=(",", ":"))))

                    raw = oll.generate_json(
                        model=s.model,
                        prompt=prompt,
                        system=s.system_prompt,
                        temperature=s.temperature,
                        top_p=s.top_p,
                    )

                    if log.isEnabledFor(logging.DEBUG):
                        try:
                            raw_json = json.dumps(raw, ensure_ascii=False, separators=(",", ":"))
                        except TypeError:
                            raw_json = json.dumps({"raw": str(raw)}, ensure_ascii=False, separators=(",", ":"))
                        log.debug("Ollama response %s", raw_json)

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