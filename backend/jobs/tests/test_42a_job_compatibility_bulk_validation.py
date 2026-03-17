import requests
import uuid


def test_post_job_compatibility_bulk_requires_jobids_array(base_url, user_headers):
    url = f"{base_url}/api/jobs/compatibility"
    r = requests.post(url, headers=user_headers, json={})

    print("Response text:", r.text, " with status ", r.status_code, end=" ")
    assert r.status_code == 400
    assert "jobIds" in r.text


def test_post_job_compatibility_bulk_rejects_invalid_guid(base_url, user_headers):
    url = f"{base_url}/api/jobs/compatibility"
    r = requests.post(url, headers=user_headers, json={"jobIds": ["not-a-guid"]})

    print("Response text:", r.text, " with status ", r.status_code, end=" ")
    assert r.status_code == 400
    assert "Invalid jobId GUID" in r.text


def test_post_job_compatibility_bulk_deduplicates_ids(base_url, user_headers, shared_state):
    assert "job_id" in shared_state, "Job not created"
    job_id = shared_state["job_id"]

    url = f"{base_url}/api/jobs/compatibility"
    r = requests.post(url, headers=user_headers, json={"jobIds": [job_id, job_id]})

    print("Response text:", r.text, " with status ", r.status_code, end=" ")
    assert r.status_code == 200, r.text

    data = r.json()
    assert "compatibility" in data
    assert list(data["compatibility"].keys()) == [job_id]