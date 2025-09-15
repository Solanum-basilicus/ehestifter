import time
import requests
from datetime import datetime, timedelta

def _iso(dt: datetime) -> str:
    # Route accepts plain ISO without timezone - keep consistent with your other tests
    return dt.replace(microsecond=0).isoformat()


def test_status_reports_aggregate_and_flat(base_url, user_headers, shared_state):
    """
    Ensures:
      - second status change recorded for the shared job
      - non-aggregated report returns >=2 rows for that job in the window
      - aggregated report returns exactly one block for the job with >=2 statuses
      - timestamps are ascending in both views
    """
    assert "job_id" in shared_state, "Job not created"
    job_id = shared_state["job_id"]

    # Flip status again to create a fresh history row after test_40’s "Applied".
    # Choose a distinct value to avoid no-op updates.
    put_url = f"{base_url}/api/jobs/{job_id}/status"
    r_put = requests.put(put_url, headers=user_headers, json={"status": "Rejected with Unfortunately"})
    print("PUT job status:", r_put.status_code, r_put.text)
    assert r_put.status_code == 200, r_put.text
    time.sleep(1.0)  # small delay to avoid identical-second timestamps in CI

    # Window: last 30 minutes to now
    start = _iso(datetime.utcnow() - timedelta(minutes=30))
    report_url = f"{base_url}/api/jobs/reports/status"

    # 1) Non-aggregated
    r_flat = requests.get(report_url, headers=user_headers, params={
        "start": start,
        "aggregate": "false"
    })
    print("GET report flat:", r_flat.status_code, r_flat.text)
    assert r_flat.status_code == 200, r_flat.text
    flat = r_flat.json()
    assert flat.get("aggregate") is False
    assert isinstance(flat.get("items"), list)
    assert flat["items"], "Report returned empty items list"

    # rows for our job
    flat_rows = [it for it in flat["items"] if it.get("jobId") == job_id]
    assert len(flat_rows) >= 2, f"Expected at least 2 rows for job {job_id}, got {len(flat_rows)}"

    # Ascending timestamps among this job's rows
    ts_flat = [it["timestamp"] for it in flat_rows]
    assert ts_flat == sorted(ts_flat), "Flat report must be sorted by ascending timestamp"

    # Last status should reflect the recent PUT
    assert flat_rows[-1]["status"] in ("Rejected with Unfortunately", "Interviewed"), "Final status should match last update"

    # 2) Aggregated
    r_agg = requests.get(report_url, headers=user_headers, params={
        "start": start,
        "aggregate": "true"
    })
    print("GET report agg:", r_agg.status_code, r_agg.text)
    assert r_agg.status_code == 200, r_agg.text
    agg = r_agg.json()
    assert agg.get("aggregate") is True
    assert isinstance(agg.get("items"), list)
    assert agg["items"], "Report returned empty items list"

    # exactly one block for our job
    blocks = [it for it in agg["items"] if it.get("jobId") == job_id]
    assert len(blocks) == 1, f"Expected a single aggregated block for job {job_id}"

    block = blocks[0]
    for k in ("jobTitle", "postingCompanyName", "hiringCompanyName", "url", "statuses"):
        assert k in block, f"Missing field {k} in aggregated block"
    assert isinstance(block["statuses"], list) and len(block["statuses"]) >= 2

    # Ascending inside the job block
    ts_agg = [s["timestamp"] for s in block["statuses"]]
    assert ts_agg == sorted(ts_agg), "Aggregated statuses must be ascending by timestamp"

    # Final status in the block should match the recent PUT
    assert block["statuses"][-1]["status"] in ("Rejected with Unfortunately", "Interviewed")