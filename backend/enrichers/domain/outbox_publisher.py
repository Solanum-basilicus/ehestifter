# enrichers/domain/outbox_publisher.py
from __future__ import annotations

import os
import logging
from datetime import datetime, timezone
from typing import Optional

from helpers.db import get_connection


def _utcnow():
    return datetime.now(timezone.utc)


class OutboxPublisher:
    """
    Publishes EnrichmentOutbox events to Service Bus queue.
    For local smoke tests, if Service Bus isn't configured, it no-ops.
    """

    def __init__(self):
        self.sb_conn = os.getenv("SERVICEBUS_CONNECTION")  # or your naming
        self.queue_name = os.getenv("SB_EVENTS_QUEUE_NAME", "enrichment-events")

    def publish_batch(self, max_items: int = 20) -> int:
        if not self.sb_conn:
            logging.info("SERVICEBUS_CONNECTION not set; skipping outbox publish (local dev ok).")
            return 0

        # Lazy import so missing packages don't break function indexing
        from azure.servicebus import ServiceBusClient, ServiceBusMessage

        items = self._load_unpublished(limit=max_items)
        if not items:
            return 0

        published = 0
        with ServiceBusClient.from_connection_string(self.sb_conn) as client:
            sender = client.get_queue_sender(queue_name=self.queue_name)
            with sender:
                for (outbox_id, event_type, aggregate_id, payload_json) in items:
                    try:
                        # Keep message body small: payload_json should be small pointers/ids
                        msg = ServiceBusMessage(
                            body=payload_json,
                            application_properties={
                                "eventType": event_type,
                                "aggregateId": str(aggregate_id),
                                "outboxId": str(outbox_id),
                            },
                        )
                        sender.send_messages(msg)
                        self._mark_published(outbox_id)
                        published += 1
                    except Exception:
                        logging.exception("Failed to publish outboxId=%s", outbox_id)
                        self._mark_failed_attempt(outbox_id, "publish_failed")

        return published

    def _load_unpublished(self, limit: int):
        conn = get_connection()
        try:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT TOP (?)
                    OutboxId, EventType, AggregateId, PayloadJson
                FROM dbo.EnrichmentOutbox
                WHERE PublishedAt IS NULL
                ORDER BY CreatedAt ASC
                """,
                limit,
            )
            return cur.fetchall()
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def _mark_published(self, outbox_id: str) -> None:
        conn = get_connection()
        now = _utcnow()
        try:
            cur = conn.cursor()
            cur.execute(
                """
                UPDATE dbo.EnrichmentOutbox
                SET PublishedAt = ?,
                    PublishAttempts = PublishAttempts + 1,
                    LastPublishError = NULL
                WHERE OutboxId = ?
                """,
                now,
                outbox_id,
            )
            conn.commit()
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def _mark_failed_attempt(self, outbox_id: str, msg: str) -> None:
        conn = get_connection()
        try:
            cur = conn.cursor()
            cur.execute(
                """
                UPDATE dbo.EnrichmentOutbox
                SET PublishAttempts = PublishAttempts + 1,
                    LastPublishError = ?
                WHERE OutboxId = ?
                """,
                msg,
                outbox_id,
            )
            conn.commit()
        finally:
            try:
                conn.close()
            except Exception:
                pass
