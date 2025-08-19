import requests

def test_put_job_status(base_url, user_headers, shared_state):
    assert "job_id" in shared_state, "Job not created"
    job_id = shared_state["job_id"]
    url = f"{base_url}/api/jobs/{job_id}/status"
    r = requests.put(url, headers=user_headers, json={"status":"Applied"})
    print("Response text:", r.text, " with status ", r.status_code, " waited for", job_id, end=" ")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["jobId"] == job_id
    assert data["status"] == "Applied"
