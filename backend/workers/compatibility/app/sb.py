import json
from dataclasses import dataclass
from typing import Any, Optional

from azure.servicebus import ServiceBusClient
from azure.servicebus import ServiceBusMessage  # noqa: F401
from azure.servicebus.received_message import ServiceBusReceivedMessage
from azure.servicebus.exceptions import ServiceBusError

@dataclass
class EnrichmentRequestMsg:
    run_id: str
    enricher_type: str
    subject_key: str
    created_at: Optional[str]

def parse_request_message(msg: ServiceBusReceivedMessage) -> Optional[EnrichmentRequestMsg]:
    try:
        raw = str(msg)
        data: dict[str, Any] = json.loads(raw)
        return EnrichmentRequestMsg(
            run_id=str(data.get("runId") or ""),
            enricher_type=str(data.get("enricherType") or ""),
            subject_key=str(data.get("subjectKey") or ""),
            created_at=(str(data.get("createdAt")) if data.get("createdAt") else None),
        )
    except Exception:
        return None

def make_client(conn_str: str) -> ServiceBusClient:
    return ServiceBusClient.from_connection_string(conn_str)