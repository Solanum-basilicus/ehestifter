# tests/test_10_jobs_create.py
import requests
import json

JOIN_URL = "https://join.com/companies/zattoo/14702571-product-manager-user-and-customization?pid=a06ced45090ea9b50597"

def test_jobs_create_minimal(base_url, system_headers, shared_state):
    url = f"{base_url}/api/jobs"
    payload = { "url": JOIN_URL }
    r = requests.post(url, headers=system_headers, json=payload)
    print("Response text:", response.text, " with status ", response.status_code, end="")
    assert r.status_code in (201, 200), r.text
    data = r.json()
    assert "id" in data
    shared_state["job_id"] = data["id"]

def test_jobs_create_idempotent(base_url, system_headers, shared_state):
    assert "job_id" in shared_state
    url = f"{base_url}/api/jobs"
    payload = { "url": JOIN_URL }
    r = requests.post(url, headers=system_headers, json=payload)
    print("Response text:", response.text, " with status ", response.status_code, end="")
    assert r.status_code in (201, 200), r.text
    data = r.json()
    assert data["id"] == shared_state["job_id"]
