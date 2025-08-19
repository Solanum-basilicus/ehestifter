import requests

def test_jobs_list(base_url, auth_headers, shared_state):
    assert "job_id" in shared_state, "Job not created"
    job_id = shared_state.get("job_id")
    url = f"{base_url}/api/jobs?limit=5&offset=0"
    r = requests.get(url, headers=auth_headers)
    print("Response text:", r.text, " with status ", r.status_code, end=" ")
    assert r.status_code == 200, r.text
    items = r.json()
    assert isinstance(items, list), "Service respond is not a list"
    try:
        ids = [job.get("Id") for job in items]
    except Exception:
        ids = "Invalid JSON"   
    if items:
        # Each item in list view includes locations array
        assert "locations" in items[0], "Locations array not present in responce"
    assert job_id in ids, "Job ID not found in responce"
