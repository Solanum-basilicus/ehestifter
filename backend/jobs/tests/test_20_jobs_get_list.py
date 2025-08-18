# tests/test_20_jobs_get_list.py
import requests

def test_jobs_get(base_url, auth_headers, shared_state):
    job_id = shared_state["job_id"]
    url = f"{base_url}/api/jobs/{job_id}"
    r = requests.get(url, headers=auth_headers)
    print("Response text:", response.text, " with status ", response.status_code, end="")
    assert r.status_code == 200, r.text
    job = r.json()
    # DB-shaped keys present
    for key in ["Id","Url","FoundOn","Provider","ProviderTenant","ExternalId","HiringCompanyName","IsDeleted","CreatedAt","FirstSeenAt"]:
        assert key in job
    assert "locations" in job and isinstance(job["locations"], list)

def test_jobs_list(base_url, auth_headers):
    url = f"{base_url}/api/jobs?limit=5&offset=0"
    r = requests.get(url, headers=auth_headers)
    print("Response text:", response.text, " with status ", response.status_code, end="")
    assert r.status_code == 200, r.text
    items = r.json()
    assert isinstance(items, list)
    if items:
        # Each item in list view includes locations array
        assert "locations" in items[0]
