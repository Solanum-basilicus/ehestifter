import os
import pytest
import requests

@pytest.mark.order(6)
def test_06_get_job_status(base_url, auth_headers, shared_state):
    user_guid = os.getenv("TEST_USER_GUID")
    if not user_guid:
        pytest.skip("TEST_USER_GUID is not configured in .env")

    job_id = shared_state.get("job_id")
    assert job_id, "No job_id in shared_state; ensure test_01_create_job ran and passed."
    expected_status = shared_state.get("expected_status") or "Applied"  # fallback

    url = f"{base_url}/api/jobs/status"
    headers = dict(auth_headers)
    headers["X-User-Id"] = user_guid

    payload = {"jobIds": [job_id]}
    resp = requests.post(url, headers=headers, json=payload, timeout=10)
    print("(GET-STATUS response:", resp.status_code, resp.text, ")", end="")

    assert resp.status_code == 200, f"Unexpected status code: {resp.status_code} - {resp.text}"
    data = resp.json()

    # Shape checks
    assert isinstance(data, dict)
    assert "userId" in data and "statuses" in data and isinstance(data["statuses"], dict)

    # GUID match (case-insensitive)
    assert str(data["userId"]).lower() == str(user_guid).lower()

    # Ensure the jobId is present and status equals what we set
    assert job_id in data["statuses"] or job_id.lower() in {k.lower() for k in data["statuses"].keys()}
    # fetch by normalized key
    normalized = {k.lower(): v for k, v in data["statuses"].items()}
    assert normalized[job_id.lower()] == expected_status
