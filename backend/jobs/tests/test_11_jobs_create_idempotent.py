import requests
import json

def test_jobs_create_idempotent(base_url, system_headers, shared_state, test_job_url):
    assert "job_id" in shared_state
    url = f"{base_url}/api/jobs"
    payload = { "url": test_job_url }
    r = requests.post(url, headers=system_headers, json=payload)
    print("Response text:", r.text, " with status ", r.status_code, end=" ")
    assert r.status_code in (201, 200), r.text
    data = r.json()
    assert data["id"] == shared_state["job_id"]
