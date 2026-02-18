import json
from azure.servicebus import ServiceBusClient, ServiceBusMessage
from helpers.settings import SB_CONNECTION_STRING, SB_QUEUE_NAME

def send_dispatch_message(payload: dict) -> str:
    body = json.dumps(payload)
    msg = ServiceBusMessage(
        body,
        content_type="application/json",
        message_id=str(payload.get("runId") or ""),
    )

    with ServiceBusClient.from_connection_string(SB_CONNECTION_STRING) as client:
        with client.get_queue_sender(queue_name=SB_QUEUE_NAME) as sender:
            sender.send_messages(msg)

    # ServiceBusMessage doesn’t expose server-assigned id for Basic the way some clients expect;
    # we return our message_id for diagnostics.
    return msg.message_id or ""
