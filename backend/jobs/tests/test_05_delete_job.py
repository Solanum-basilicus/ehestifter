import pytest
import requests

def test_05_delete_job(base_url, auth_headers, shared_state):
    job_id = shared_state.get("job_id")
    assert job_id, "No job ID available"    
    response = requests.delete(f"{base_url}/api/jobs/{job_id}", headers=auth_headers)
    print("(DELETE response:", response.status_code, response.text, ")", end="")
    assert response.status_code == 200
