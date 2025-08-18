# tests/test_40_job_status.py
import requests

def test_put_job_status(base_url, user_headers, shared_state):
    job_id = shared_state["job_id"]
    url = f"{base_url}/api/jobs/{job_id}/status"
    r = requests.put(url, headers=user_headers, json={"status":"Applied"})
    print("Response text:", response.text, " with status ", response.status_code, end="")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["jobId"] == job_id
    assert data["status"] == "Applied"

def test_post_job_statuses_bulk(base_url, user_headers, shared_state):
    job_id = shared_state["job_id"]
    url = f"{base_url}/api/jobs/status"
    r = requests.post(url, headers=user_headers, json={"jobIds":[job_id]})
    print("Response text:", response.text, " with status ", response.status_code, end="")
    assert r.status_code == 200, r.text
    data = r.json()
    assert "statuses" in data
    assert data["statuses"].get(job_id) in ("Applied","Unset")
