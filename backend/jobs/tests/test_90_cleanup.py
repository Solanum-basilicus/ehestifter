# tests/test_90_cleanup.py
import requests

def test_jobs_delete(base_url, system_headers, shared_state):
    job_id = shared_state["job_id"]
    url = f"{base_url}/api/jobs/{job_id}"
    r = requests.delete(url, headers=system_headers)
    print("Response text:", r.text, " with status ", r.status_code, end=" ")
    assert r.status_code == 200, r.text
