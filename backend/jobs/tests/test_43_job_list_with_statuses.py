import requests

def test_jobs_with_statuses_list(base_url, user_headers, shared_state, test_user_id):
    assert "job_id" in shared_state, "Job not created"
    job_id = shared_state["job_id"]

    url = f"{base_url}/api/jobs/with-statuses?userId={test_user_id}&limit=10&offset=0"
    r = requests.get(url, headers=user_headers)
    print("Response text:", r.text, " with status ", r.status_code, end=" ")
    assert r.status_code == 200, r.text

    items = r.json()
    assert isinstance(items, list), "Service response is not a list"

    ids = [it.get("Id") for it in items]
    assert job_id in ids, f"Job {job_id} with status should appear in results"

    job = next(it for it in items if it["Id"] == job_id)
    assert job["userStatus"] == "Applied", f"Expected 'Applied', got {job['userStatus']}"
    assert "locations" in job, "Locations missing in response"