# enrichers/helpers/enrichment_snapshot.py
import json
from typing import Any, Dict
from helpers.blob_storage import enrichments_upload_json
from helpers.db import get_connection

def _update_snapshot_path(run_id: str, blob_path: str) -> None:
    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            UPDATE dbo.EnrichmentRuns
            SET InputSnapshotBlobPath = ?, UpdatedAt = SYSUTCDATETIME()
            WHERE RunId = ?
            """,
            blob_path,
            run_id,
        )
        conn.commit()
    finally:
        try:
            conn.close()
        except Exception:
            pass

def write_input_snapshot(run: Dict[str, Any], snapshot: Dict[str, Any]) -> str:
    run_id = run["runId"]
    blob_path = f"runs/{run_id}/input.json"

    # Writes to the env-configured ENRICHMENTS_STORAGE__containerName container
    enrichments_upload_json(blob_path, snapshot, overwrite=True)
    _update_snapshot_path(run_id, blob_path)

    return blob_path
