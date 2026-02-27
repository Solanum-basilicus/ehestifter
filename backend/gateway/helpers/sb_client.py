# helpers/sb_client.py
import json
import logging
from typing import Optional

from azure.servicebus import ServiceBusClient, ServiceBusMessage
from azure.servicebus.exceptions import ServiceBusError  # broad base
from helpers.settings import SB_CONNECTION_STRING, SB_QUEUE_NAME


def send_dispatch_message(payload: dict, corr: Optional[str] = None) -> str:
    run_id = str(payload.get("runId") or "")

    # Keep SB body minimal per design doc if you want; but right now you're sending full payload.
    body = json.dumps(payload, ensure_ascii=False)

    msg = ServiceBusMessage(
        body,
        content_type="application/json",
        message_id=run_id,
        correlation_id=corr,
        subject=str(payload.get("enricherType") or ""),
    )
    # Add app props for portal/diagnostics (safe)
    msg.application_properties = {
        "runId": run_id,
        "enricherType": str(payload.get("enricherType") or ""),
        "subjectKey": str(payload.get("subjectKey") or ""),
    }
    if corr:
        msg.application_properties["corr"] = corr

    logging.info("SB send start queue=%s runId=%s corr=%s", SB_QUEUE_NAME, run_id, corr)

    try:
        with ServiceBusClient.from_connection_string(SB_CONNECTION_STRING) as client:
            with client.get_queue_sender(queue_name=SB_QUEUE_NAME) as sender:
                sender.send_messages(msg)
    except ServiceBusError as e:
        logging.exception("SB send failed queue=%s runId=%s corr=%s", SB_QUEUE_NAME, run_id, corr)
        raise
    except Exception:
        logging.exception("SB send failed (non-ServiceBusError) queue=%s runId=%s corr=%s", SB_QUEUE_NAME, run_id, corr)
        raise

    logging.info("SB send ok queue=%s runId=%s messageId=%s corr=%s", SB_QUEUE_NAME, run_id, msg.message_id, corr)
    return msg.message_id or ""