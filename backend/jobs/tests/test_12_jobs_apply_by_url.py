import requests
import json

def test_jobs_apply_by_url(base_url, user_headers, shared_state, test_job_url2):
    assert "job_id" in shared_state, "Job not created"
    """
    POST /jobs/apply-by-url should normalize the URL, create the job if needed,
    and set the user's status to Applied. It should return jobId, title, company, link.
    Then verify via GET /jobs/with-statuses that the status is indeed Applied.
    """
    # 1) Call the combined endpoint
    url = f"{base_url}/api/jobs/apply-by-url"
    payload = {"url": test_job_url2, "status": "Applied"}
    r = requests.post(url, headers=user_headers, json=payload)
    print("Response text:", r.text, " with status ", r.status_code, end=" ")
    assert r.status_code == 200, r.text

    data = r.json()
    assert "jobId" in data, data
    assert "title" in data, data
    assert "company" in data, data
    assert "link" in data, data
    assert data.get("status") == "Applied"
    job_id = data["jobId"]

    # 2) Verify status using /jobs/with-statuses
    #    This endpoint expects userId as a query param; reuse the same value from X-User-Id header.
    user_id = user_headers.get("X-User-Id")
    assert user_id, "user_headers must include X-User-Id for status verification"

    list_url = f"{base_url}/api/jobs/with-statuses"
    params = {"userId": user_id, "limit": "50", "offset": "0"}
    r2 = requests.get(list_url, headers=user_headers, params=params)
    print("List response text:", r2.text, " with status ", r2.status_code, end=" ")
    assert r2.status_code == 200, r2.text
    items = r2.json()
    assert isinstance(items, list), "Expected list from /jobs/with-statuses"

    # Find the created job and assert the status
    match = None
    for it in items:
        # Id casing may vary; compare normalized lower
        if str(it.get("Id", "")).lower() == str(job_id).lower():
            match = it
            break

    assert match is not None, f"Job {job_id} not found in /jobs/with-statuses"
    # The field is userStatus in your API shape
    assert str(match.get("userStatus", "")).lower() == "applied", f"Unexpected userStatus: {match}"

    # 3) Save for dedicated cleanup
    shared_state["job_id_apply_url"] = job_id