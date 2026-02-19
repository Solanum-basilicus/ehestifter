# enrichers/helpers/enrichment_snapshot.py
import json
from typing import Any, Dict
from helpers.blob_storage import upload_text
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
    """
    Writes enrichment/runs/{runId}/input.json and updates DB InputSnapshotBlobPath
    to runs/{runId}/input.json (or enrichment/runs/... if you prefer consistency).
    """
    run_id = run["runId"]
    blob_path = f"runs/{run_id}/input.json"

    upload_text(container="enrichment", blob_path=blob_path, text=json.dumps(snapshot, ensure_ascii=False))
    _update_snapshot_path(run_id, blob_path)

    return blob_path
