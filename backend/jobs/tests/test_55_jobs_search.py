import requests

# These search tests assume:
# - test_30_jobs_update.py updated the job with Title "Product Manager (Test)"
#   and locations including Berlin, Madrid, London
# - test_40_job_status.py set status to "Applied"

def _find_ids(payload):
    assert isinstance(payload, dict), "Response is not an envelope object"
    items = payload.get("items", [])
    return [it.get("Id") for it in items]

def test_jobs_search_by_title_company(base_url, user_headers, shared_state):
    job_id = shared_state.get("job_id")
    assert job_id, "Job not created"
    # Search across Title+Company for a substring of the updated title
    url = f"{base_url}/api/jobs?category=my&search_field=title_company&q=Product%20Manager&limit=50&offset=0"
    r = requests.get(url, headers=user_headers)
    print("\Response text:", r.text, " with status ", r.status_code, end=" ")
    assert r.status_code == 200, r.text
    ids = _find_ids(r.json())
    assert job_id in ids, "Job not found by Title+Company search"

def test_jobs_search_by_title_exactish(base_url, user_headers, shared_state):
    job_id = shared_state.get("job_id")
    assert job_id, "Job not created"
    # Title-only search
    url = f"{base_url}/api/jobs?category=my&search_field=title&q=Product%20Manager%20(Test)&limit=50&offset=0"
    r = requests.get(url, headers=user_headers)
    print("\Response text:", r.text, " with status ", r.status_code, end=" ")
    assert r.status_code == 200, r.text
    ids = _find_ids(r.json())
    assert job_id in ids, "Job not found by Title search"

def test_jobs_search_by_location_city(base_url, user_headers, shared_state):
    job_id = shared_state.get("job_id")
    assert job_id, "Job not created"
    # Location-only search (city)
    url = f"{base_url}/api/jobs?category=my&search_field=location&q=Berlin&limit=50&offset=0"
    r = requests.get(url, headers=user_headers)
    print("\Response text:", r.text, " with status ", r.status_code, end=" ")
    assert r.status_code == 200, r.text
    ids = _find_ids(r.json())
    assert job_id in ids, "Job not found by Location search (city=Berlin)"
