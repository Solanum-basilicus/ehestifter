import requests

def test_02_list_jobs(base_url, auth_headers, shared_state):
    job_id = shared_state.get("job_id")
    assert job_id, "Job not created"    
    response = requests.get(f"{base_url}/api/jobs?limit=20", headers=auth_headers)    
    try:
        ids = [job.get("Id") for job in response.json()]
    except Exception:
        ids = "Invalid JSON"    
    print("(LIST response:", response.status_code, ids, ")", end="")
    assert response.status_code == 200
    assert job_id in ids