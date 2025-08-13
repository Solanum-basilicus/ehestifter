import pytest
import requests
from datetime import datetime

def test_04_update_job(base_url, auth_headers, shared_state):
    job_id = shared_state.get("job_id")
    assert job_id, "No job ID available"

    updated_payload = {
        "Source": "IntegrationTests",
        "ExternalId": shared_state["external_id"], 
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