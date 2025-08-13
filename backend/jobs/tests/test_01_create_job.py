import pytest
import requests
import uuid
from datetime import datetime

def test_01_create_job(base_url, auth_headers, shared_state):
    payload = {
        "Source": "IntegrationTests",
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








