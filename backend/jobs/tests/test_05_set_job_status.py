import os
import pytest
import requests

STATUS_TO_SET = "Applied"  # pick any of your UI-allowed statuses

def test_05_set_job_status(base_url, auth_headers, shared_state):
    user_guid = os.getenv("TEST_USER_GUID")
    if not user_guid:
        pytest.skip("TEST_USER_GUID is not configured in .env")

    job_id = shared_state.get("job_id")
    assert job_id, "No job_id in shared_state; ensure test_01_create_job ran and passed."

    url = f"{base_url}/api/jobs/{job_id}/status"
    headers = dict(auth_headers)
    headers["X-User-Id"] = user_guid

    payload = {"status": STATUS_TO_SET}
    resp = requests.put(url, headers=headers, json=payload, timeout=10)
    print("(SET-STATUS response:", resp.status_code, resp.text, ")", end="")

    assert resp.status_code == 200, f"Unexpected status code: {resp.status_code} - {resp.text}"
    data = resp.json()

    # Basic shape
    assert isinstance(data, dict)
    assert "jobId" in data and "userId" in data and "status" in data

    # Validate round-trip values (case-insensitive compare for GUIDs)
    assert data["status"] == STATUS_TO_SET
    assert str(data["jobId"]).lower() == str(job_id).lower()
    assert str(data["userId"]).lower() == str(user_guid).lower()

    # Keep what we set for the next test
    shared_state["expected_status"] = STATUS_TO_SET
