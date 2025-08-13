import pytest
import requests

def test_03_get_job(base_url, auth_headers, shared_state):
    job_id = shared_state.get("job_id")
    assert job_id, "No job ID available"    
    response = requests.get(f"{base_url}/api/jobs/{job_id}", headers=auth_headers)
    assert response.status_code == 200
    try:
        response_data = response.json()
        returned_id = response_data.get("Id")  # use "id" if your API uses lowercase
    except Exception:
        returned_id = "Invalid JSON"
    print(f"(GET response: {response.status_code}, ID: {returned_id})", end="")
    assert returned_id == job_id
