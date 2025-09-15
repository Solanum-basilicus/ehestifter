# ./tests/test_60_job_status_reports.py
import time
import requests
from datetime import datetime, timedelta

def _iso(dt: datetime) -> str:
    # Route accepts plain ISO without timezone - keep consistent with your other tests
    return dt.replace(microsecond=0).isoformat()

def test_status_reports_non_aggregated_base(base_url, user_headers, shared_state):
    """
    Basic smoke test for non-aggregated report:
      - 'end' omitted -> up to this moment
      - window within the last 24h
      - verifies 200 and response shape
      - verifies ascending by timestamp when items exist
    """
    start = _iso(datetime.utcnow() - timedelta(days=1))
    url = f"{base_url}/api/jobs/reports/status"
    r = requests.get(url, headers=user_headers, params={
        "start": start,
        "aggregate": "false"
    })
    print("GET /jobs/reports/status non-agg:", r.status_code, r.text[:300])
    assert r.status_code == 200, r.text
    data = r.json()
    assert data.get("aggregate") is False
    assert "items" in data and isinstance(data["items"], list)

    if data["items"]:
        row = data["items"][0]
        for k in ("jobId", "jobTitle", "postingCompanyName", "hiringCompanyName", "url", "status", "timestamp"):
            assert k in row, f"Missing field {k} in non-aggregated row"
        # Ascending timestamps across the whole list
        ts = [it["timestamp"] for it in data["items"]]
        assert ts == sorted(ts), "Items must be sorted by ascending timestamp"
