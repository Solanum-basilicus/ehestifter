import pytest
import requests
import uuid
from datetime import datetime

def test_01_create_job(base_url, auth_headers, shared_state):
    payload = {
        "Source": "TestSource",
        "ExternalId": str(uuid.uuid4()),
        "Url": "https://example.com/job",
        "HiringCompanyName": "Example Corp",
        "Title": "Integration Tester",
        "Country": "Germany",
        "PostedDate": datetime.utcnow().isoformat()
    }

    response = requests.post(f"{base_url}/api/jobs", headers=auth_headers, json=payload)
    print("(CREATE response:", response.status_code, response.text, ")", end="")
    assert response.status_code == 201
    response_json = response.json()
    job_id = response_json.get("id")
    assert job_id is not None, "POST did not return job ID"

    shared_state["job_id"] = job_id
    shared_state["external_id"] = payload["ExternalId"]  # Keep if other tests use it

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

def test_04_update_job(base_url, auth_headers, shared_state):
    job_id = shared_state.get("job_id")
    assert job_id, "No job ID available"

    updated_payload = {
        "Source": "TestSource",
        "ExternalId": shared_state["external_id"],  # still required by the API schema
        "Url": "https://example.com/updated-job",
        "ApplyUrl": "https://example.com/apply",
        "HiringCompanyName": "Updated Corp",
        "PostingCompanyName": "Posting AG",
        "Title": "Updated Title",
        "Country": "Germany",
        "Locality": "Berlin",
        "RemoteType": "remote",
        "Description": "Updated job description",
        "PostedDate": datetime.utcnow().isoformat()
    }

    response = requests.put(f"{base_url}/api/jobs/{job_id}", headers=auth_headers, json=updated_payload)
    print("(UPDATE response:", response.status_code, response.text, ")", end="")
    assert response.status_code == 200

def test_05_delete_job(base_url, auth_headers, shared_state):
    job_id = shared_state.get("job_id")
    assert job_id, "No job ID available"    
    response = requests.delete(f"{base_url}/api/jobs/{job_id}", headers=auth_headers)
    print("(DELETE response:", response.status_code, response.text, ")", end="")
    assert response.status_code == 200
