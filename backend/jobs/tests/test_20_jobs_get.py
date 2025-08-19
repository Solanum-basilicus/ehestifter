import requests

def test_jobs_get(base_url, auth_headers, shared_state):
    assert "job_id" in shared_state, "Job not created"
    job_id = shared_state["job_id"]
    url = f"{base_url}/api/jobs/{job_id}"
    r = requests.get(url, headers=auth_headers)
    print("Response text:", r.text, " with status ", r.status_code, end=" ")
    assert r.status_code == 200, r.text
    job = r.json()
    # DB-shaped keys present
    for key in ["Id","Url","FoundOn","Provider","ProviderTenant","ExternalId","HiringCompanyName","IsDeleted","CreatedAt","FirstSeenAt"]:
        assert key in job
    assert "locations" in job and isinstance(job["locations"], list)
