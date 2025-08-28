import requests

def test_jobs_list(base_url, user_headers, shared_state):
    assert "job_id" in shared_state, "Job not created"
    job_id = shared_state.get("job_id")
    # Use category=my so the job created by this user is included;
    # use a larger limit to reduce flakiness in noisy environments.
    url = f"{base_url}/api/jobs?category=all&sort=created_desc&limit=50&offset=0"
    r = requests.get(url, headers=user_headers)
    print("Response text:", r.text, " with status ", r.status_code, end=" ")
    assert r.status_code == 200, r.text
    payload = r.json()
    assert isinstance(payload, dict), "Response is not an envelope object"
    assert "items" in payload, "Envelope missing 'items'"
    assert "total" in payload, "Envelope missing 'total'"
    items = payload.get("items", [])
    assert isinstance(items, list), "Envelope 'items' is not a list"
    if items:
        # Each item in list view includes locations array
        assert "locations" in items[0], "Locations array not present in response"
    ids = [job.get("Id") for job in items]
    assert job_id in ids, "Job ID not found in response"
