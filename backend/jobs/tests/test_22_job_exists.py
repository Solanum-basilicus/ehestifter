# tests/test_22_job_exists.py
import uuid
import requests

def _get_job(base_url, auth_headers, job_id):
    url = f"{base_url}/api/jobs/{job_id}"
    r = requests.get(url, headers=auth_headers)
    print("GET job response:", r.text, " status:", r.status_code, end=" ")
    assert r.status_code == 200, r.text
    return r.json()

def test_jobs_exists_positive(base_url, auth_headers, shared_state):
    assert "job_id" in shared_state, "Job not created"
    job_id = shared_state["job_id"]

    # Fetch the job to read the uniqueness triple
    job = _get_job(base_url, auth_headers, job_id)
    provider = job["Provider"]
    provider_tenant = job["ProviderTenant"]
    external_id = job["ExternalId"]

    # Exercise GET /jobs/exists
    url = (
        f"{base_url}/api/jobs/exists"
        f"?provider={requests.utils.quote(str(provider))}"
        f"&providerTenant={requests.utils.quote(str(provider_tenant))}"
        f"&externalId={requests.utils.quote(str(external_id))}"
    )
    r = requests.get(url, headers=auth_headers)
    print("GET /jobs/exists response:", r.text, " status:", r.status_code, end=" ")
    assert r.status_code == 200, r.text

    body = r.json()
    assert body["exists"] is True
    assert body["id"] == job_id
    # Location header should point to the job
    assert "Location" in r.headers
    assert r.headers["Location"].endswith(f"/jobs/{job_id}")

    # Exercise HEAD /jobs/exists
    r2 = requests.head(url, headers=auth_headers)
    print("HEAD /jobs/exists status:", r2.status_code, end=" ")
    assert r2.status_code == 200
    # No body for HEAD
    assert not r2.text

def test_jobs_exists_negative(base_url, auth_headers, shared_state):
    assert "job_id" in shared_state, "Job not created"
    job_id = shared_state["job_id"]

    # Fetch the job to reuse provider + tenant
    job = _get_job(base_url, auth_headers, job_id)
    provider = job["Provider"]
    provider_tenant = job["ProviderTenant"]

    # Use a new externalId to ensure non-existence
    non_existing_external_id = str(uuid.uuid4())

    url = (
        f"{base_url}/api/jobs/exists"
        f"?provider={requests.utils.quote(str(provider))}"
        f"&providerTenant={requests.utils.quote(str(provider_tenant))}"
        f"&externalId={requests.utils.quote(non_existing_external_id)}"
    )

    # GET should report exists=false and no Location header
    r = requests.get(url, headers=auth_headers)
    print("GET /jobs/exists (negative) response:", r.text, " status:", r.status_code, end=" ")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["exists"] is False
    assert body["id"] is None
    assert "Location" not in r.headers

    # HEAD should be 404 for non-existent
    r2 = requests.head(url, headers=auth_headers)
    print("HEAD /jobs/exists (negative) status:", r2.status_code, end=" ")
    assert r2.status_code == 404
