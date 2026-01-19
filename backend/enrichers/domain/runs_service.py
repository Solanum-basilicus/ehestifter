# enrichers/domain/runs_service.py
from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional, Dict, List

from helpers.db import get_connection


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _subject_key(job_offering_id: str, user_id: str) -> str:
    return f"{job_offering_id}:{user_id}"


def _json_dumps(obj: Any) -> str:
    # Ensure stable JSON for storage; keep compact
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


@dataclass
class RunRow:
    runId: str
    enricherType: str
    subjectKey: str
    jobOfferingId: str
    userId: str
    status: str
    requestedAt: str
    queuedAt: Optional[str] = None
    leasedAt: Optional[str] = None
    leaseUntil: Optional[str] = None
    leaseToken: Optional[str] = None
    cvVersionId: Optional[str] = None
    inputSnapshotBlobPath: Optional[str] = None
    enrichmentAttributesJson: Optional[Any] = None
    resultJson: Optional[Any] = None
    errorCode: Optional[str] = None
    errorMessage: Optional[str] = None
    completedAt: Optional[str] = None
    updatedAt: str = ""


class RunsService:
    """
    Enrichment Core service: owns run lifecycle + storage.
    - Create run (supersede previous active)
    - Read run/latest/history
    - Complete run (insert outbox event ONLY on success)
    """

    def create_run(self, job_offering_id: str, user_id: str, enricher_type: str) -> Dict[str, Any]:
        """
        Creates a new run:
          - supersedes existing active runs for (subjectKey,enricherType)
          - inserts Pending run
          - tries to build blob snapshot (best-effort; can fail)
          - tries to dispatch via WorkerGateway (best-effort; can fail)
          - marks run Queued if dispatch succeeds
        """
        now = _utcnow()
        run_id = str(uuid.uuid4())
        subject_key = _subject_key(job_offering_id, user_id)

        # Fetch CV pointers + job snapshot basics (best effort; may fail if DB not configured)
        cv_version_id, cv_text_blob_path = self._get_user_cv(user_id)
        job = self._get_job_snapshot(job_offering_id)

        # 1) DB transaction: supersede + insert
        conn = get_connection()
        try:
            conn.autocommit = False
            cur = conn.cursor()

            # Supersede active runs
            cur.execute(
                """
                UPDATE dbo.EnrichmentRuns
                SET Status = 'Superseded',
                    UpdatedAt = ?
                WHERE EnricherType = ?
                  AND SubjectKey = ?
                  AND Status IN ('Pending','Queued','Leased')
                """,
                now,
                enricher_type,
                subject_key,
            )

            # Insert new run
            cur.execute(
                """
                INSERT INTO dbo.EnrichmentRuns
                (RunId, EnricherType, SubjectKey, JobOfferingId, UserId,
                 Status, RequestedAt, CVVersionId, UpdatedAt)
                VALUES (?, ?, ?, ?, ?, 'Pending', ?, ?, ?)
                """,
                run_id,
                enricher_type,
                subject_key,
                job_offering_id,
                user_id,
                now,
                cv_version_id,
                now,
            )

            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            try:
                conn.close()
            except Exception:
                pass

        # 2) Build snapshot and upload to blob (optional for now; can fail in local smoke test)
        snapshot_path = None
        try:
            snapshot = {
                "runId": run_id,
                "enricherType": enricher_type,
                "subject": {"jobOfferingId": job_offering_id, "userId": user_id},
                "job": job,
                "cv": {
                    "versionId": cv_version_id,
                    "textBlobPath": cv_text_blob_path,
                    # NOTE: do not inline cv text here; worker will fetch it from snapshot (or you can inline)
                    # If you prefer inlining, read blob now and put under "text"
                },
                "createdAt": now.isoformat(),
            }
            snapshot_bytes = _json_dumps(snapshot).encode("utf-8")

            snapshot_path = self._upload_snapshot(run_id, snapshot_bytes)
            if snapshot_path:
                self._set_snapshot_path(run_id, snapshot_path)
        except Exception:
            logging.exception("Snapshot upload failed (non-fatal for now)")

        # 3) Dispatch via WorkerGateway (optional for now)
        dispatched = False
        try:
            dispatched = self._dispatch_to_gateway(
                run_id=run_id,
                enricher_type=enricher_type,
                subject_key=subject_key,
                created_at=now.isoformat(),
            )
        except Exception:
            logging.exception("Gateway dispatch failed (non-fatal for now)")

        # 4) If dispatched, mark Queued
        if dispatched:
            try:
                self._mark_queued(run_id)
            except Exception:
                logging.exception("Failed to mark run Queued")

        # Return current run row
        return self.get_run(run_id)

    def complete_run(
        self,
        run_id: str,
        status: str,
        result_json: Optional[Any] = None,
        attributes_json: Optional[Any] = None,
        error_code: Optional[str] = None,
        error_message: Optional[str] = None,
    ) -> None:
        """
        Sets run to Succeeded/Failed and (if Succeeded) inserts EnrichmentRunCompleted into Outbox.
        Per your rule: we ignore failed/superseded downstream, so only Succeeded creates outbox event.
        """
        if status not in ("Succeeded", "Failed"):
            raise ValueError("status must be 'Succeeded' or 'Failed'")

        now = _utcnow()

        conn = get_connection()
        try:
            conn.autocommit = False
            cur = conn.cursor()

            # Load current status (idempotency)
            cur.execute("SELECT Status, EnricherType, SubjectKey, JobOfferingId, UserId, RequestedAt FROM dbo.EnrichmentRuns WHERE RunId = ?", run_id)
            row = cur.fetchone()
            if not row:
                raise ValueError("Run not found")

            current_status = row[0]
            enricher_type = row[1]
            subject_key = row[2]
            job_offering_id = row[3]
            user_id = row[4]
            requested_at = row[5]

            if current_status in ("Succeeded", "Failed", "Superseded", "Expired"):
                # idempotent: nothing to do
                conn.commit()
                return

            # Update run
            cur.execute(
                """
                UPDATE dbo.EnrichmentRuns
                SET Status = ?,
                    ResultJson = ?,
                    EnrichmentAttributesJson = ?,
                    ErrorCode = ?,
                    ErrorMessage = ?,
                    CompletedAt = ?,
                    UpdatedAt = ?
                WHERE RunId = ?
                """,
                status,
                _json_dumps(result_json) if result_json is not None else None,
                _json_dumps(attributes_json) if attributes_json is not None else None,
                error_code,
                error_message,
                now,
                now,
                run_id,
            )

            # Outbox insert ONLY on success
            if status == "Succeeded":
                payload = {
                    "eventType": "EnrichmentRunCompleted",
                    "runId": run_id,
                    "enricherType": enricher_type,
                    "subjectKey": subject_key,
                    "jobOfferingId": str(job_offering_id),
                    "userId": str(user_id),
                    "requestedAt": requested_at.isoformat() if hasattr(requested_at, "isoformat") else str(requested_at),
                    "completedAt": now.isoformat(),
                }
                outbox_id = str(uuid.uuid4())
                cur.execute(
                    """
                    INSERT INTO dbo.EnrichmentOutbox
                    (OutboxId, EventType, AggregateId, CreatedAt, PayloadJson)
                    VALUES (?, 'EnrichmentRunCompleted', ?, ?, ?)
                    """,
                    outbox_id,
                    run_id,
                    now,
                    _json_dumps(payload),
                )

            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def get_run(self, run_id: str) -> Dict[str, Any]:
        conn = get_connection()
        try:
            cur = conn.cursor()
            cur.execute("SELECT * FROM dbo.EnrichmentRuns WHERE RunId = ?", run_id)
            row = cur.fetchone()
            if not row:
                raise ValueError("Run not found")
            cols = [c[0] for c in cur.description]
            d = dict(zip(cols, row))

            # Normalize keys to your API casing
            return self._normalize_run_row(d)
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def get_latest(self, job_offering_id: str, user_id: str, enricher_type: str) -> Optional[Dict[str, Any]]:
        subject_key = _subject_key(job_offering_id, user_id)
        conn = get_connection()
        try:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT TOP 1 * FROM dbo.EnrichmentRuns
                WHERE EnricherType = ? AND SubjectKey = ?
                ORDER BY RequestedAt DESC
                """,
                enricher_type,
                subject_key,
            )
            row = cur.fetchone()
            if not row:
                return None
            cols = [c[0] for c in cur.description]
            d = dict(zip(cols, row))
            return self._normalize_run_row(d)
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def get_history(
        self,
        job_offering_id: str,
        user_id: str,
        enricher_type: str,
        limit: int = 50,
        offset: int = 0,
    ) -> List[Dict[str, Any]]:
        subject_key = _subject_key(job_offering_id, user_id)
        conn = get_connection()
        try:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT * FROM dbo.EnrichmentRuns
                WHERE EnricherType = ? AND SubjectKey = ?
                ORDER BY RequestedAt DESC
                OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
                """,
                enricher_type,
                subject_key,
                offset,
                limit,
            )
            rows = cur.fetchall()
            cols = [c[0] for c in cur.description]
            result: List[Dict[str, Any]] = []
            for r in rows:
                d = dict(zip(cols, r))
                result.append(self._normalize_run_row(d))
            return result
        finally:
            try:
                conn.close()
            except Exception:
                pass

    # --------------------
    # Internal helpers
    # --------------------

    def _get_user_cv(self, user_id: str) -> tuple[Optional[str], Optional[str]]:
        """
        Returns (CVVersionId, CVTextBlobPath). Best-effort.
        """
        conn = get_connection()
        try:
            cur = conn.cursor()
            cur.execute(
                "SELECT CVVersionId, CVTextBlobPath FROM dbo.UserPreferences WHERE UserId = ?",
                user_id,
            )
            row = cur.fetchone()
            if not row:
                return None, None
            return row[0], row[1]
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def _get_job_snapshot(self, job_offering_id: str) -> Dict[str, Any]:
        """
        Minimal job snapshot used by worker. Best-effort; raises if not found.
        """
        conn = get_connection()
        try:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT Id, Title, Description, Url, HiringCompanyName, PostingCompanyName, FoundOn, Provider, ProviderTenant, ExternalId
                FROM dbo.JobOfferings
                WHERE Id = ?
                """,
                job_offering_id,
            )
            row = cur.fetchone()
            if not row:
                raise ValueError("JobOffering not found")

            return {
                "id": str(row[0]),
                "title": row[1],
                "description": row[2],
                "url": row[3],
                "hiringCompanyName": row[4],
                "postingCompanyName": row[5],
                "foundOn": row[6],
                "provider": row[7],
                "providerTenant": row[8],
                "externalId": row[9],
            }
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def _upload_snapshot(self, run_id: str, content: bytes) -> Optional[str]:
        """
        Upload to blob if blob helper is available/configured.
        Returns blob path string or None.
        """
        try:
            # Expect you have helpers/blob_storage.py with an upload function.
            # If not, this will no-op safely (caught by caller).
            from helpers.blob_storage import upload_text  # type: ignore
        except Exception as e:
            logging.info("Blob helper not available yet (upload_text missing): %s", e)
            return None

        path = f"enrichment/runs/{run_id}/input.json"
        upload_text(container="enrichment", blob_path=f"runs/{run_id}/input.json", text=content.decode("utf-8"))
        return path

    def _set_snapshot_path(self, run_id: str, blob_path: str) -> None:
        now = _utcnow()
        conn = get_connection()
        try:
            cur = conn.cursor()
            cur.execute(
                """
                UPDATE dbo.EnrichmentRuns
                SET InputSnapshotBlobPath = ?, UpdatedAt = ?
                WHERE RunId = ?
                """,
                blob_path,
                now,
                run_id,
            )
            conn.commit()
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def _dispatch_to_gateway(self, run_id: str, enricher_type: str, subject_key: str, created_at: str) -> bool:
        """
        Best-effort dispatch.
        Returns True if dispatched, False if gateway not configured.
        """
        import os
        gateway_base = os.getenv("EHESTIFTER_GATEWAY_BASE_URL")
        if not gateway_base:
            # local smoke test: allow running without gateway configured
            logging.info("Gateway base URL not configured; leaving run Pending")
            return False

        # Use async httpx in caller? Here keep it simple (sync) to avoid async route work.
        import httpx
        fn_key = os.getenv("EHESTIFTER_GATEWAY_FUNCTION_KEY")
        headers = {"x-functions-key": fn_key} if fn_key else {}

        url = gateway_base.rstrip("/") + "/gateway/dispatch"
        payload = {
            "runId": run_id,
            "enricherType": enricher_type,
            "subjectKey": subject_key,
            "createdAt": created_at,
        }
        r = httpx.post(url, headers=headers, json=payload, timeout=10.0)
        r.raise_for_status()
        return True

    def _mark_queued(self, run_id: str) -> None:
        now = _utcnow()
        conn = get_connection()
        try:
            cur = conn.cursor()
            cur.execute(
                """
                UPDATE dbo.EnrichmentRuns
                SET Status = 'Queued',
                    QueuedAt = ?,
                    UpdatedAt = ?
                WHERE RunId = ? AND Status = 'Pending'
                """,
                now,
                now,
                run_id,
            )
            conn.commit()
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def _normalize_run_row(self, d: Dict[str, Any]) -> Dict[str, Any]:
        """
        Convert DB row dict to API-friendly shape.
        """
        def iso(v):
            if v is None:
                return None
            try:
                return v.isoformat()
            except Exception:
                return str(v)

        out: Dict[str, Any] = {
            "runId": str(d.get("RunId")),
            "enricherType": d.get("EnricherType"),
            "subjectKey": d.get("SubjectKey"),
            "jobOfferingId": str(d.get("JobOfferingId")),
            "userId": str(d.get("UserId")),
            "status": d.get("Status"),
            "requestedAt": iso(d.get("RequestedAt")),
            "queuedAt": iso(d.get("QueuedAt")),
            "leasedAt": iso(d.get("LeasedAt")),
            "leaseUntil": iso(d.get("LeaseUntil")),
            "leaseToken": str(d.get("LeaseToken")) if d.get("LeaseToken") else None,
            "cvVersionId": d.get("CVVersionId"),
            "inputSnapshotBlobPath": d.get("InputSnapshotBlobPath"),
            "errorCode": d.get("ErrorCode"),
            "errorMessage": d.get("ErrorMessage"),
            "completedAt": iso(d.get("CompletedAt")),
            "updatedAt": iso(d.get("UpdatedAt")),
        }

        # Parse JSON fields (if present)
        attrs_raw = d.get("EnrichmentAttributesJson")
        res_raw = d.get("ResultJson")
        out["enrichmentAttributesJson"] = self._maybe_parse_json(attrs_raw)
        out["resultJson"] = self._maybe_parse_json(res_raw)
        return out

    def _maybe_parse_json(self, v: Any) -> Any:
        if v is None:
            return None
        if isinstance(v, (dict, list)):
            return v
        if isinstance(v, str):
            try:
                return json.loads(v)
            except Exception:
                return v
        return v
