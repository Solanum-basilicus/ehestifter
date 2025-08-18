import requests
import json

def test_jobs_create_minimal(base_url, system_headers, shared_state, test_job_url):
    url = f"{base_url}/api/jobs"
    payload = { "url": test_job_url }
    r = requests.post(url, headers=system_headers, json=payload)
    print("Response text:", r.text, " with status ", r.status_code, end=" ")
    assert r.status_code in (201, 200), r.text
    data = r.json()
    assert "id" in data
    shared_state["job_id"] = data["id"]

