import requests
import uuid


def test_create_job_as_user_for_my_category(base_url, user_headers, shared_state):
    unique_url = f"https://example.com/jobs/test-my-category-{uuid.uuid4()}"
    url = f"{base_url}/api/jobs"
    payload = {"url": unique_url}

    r = requests.post(url, headers=user_headers, json=payload)
    print("CREATE USER JOB Response:", r.status_code, r.text)
    assert r.status_code in (200, 201), r.text

    data = r.json()
    assert "id" in data, "Response missing job id"

    shared_state["my_job_id"] = data["id"]
    shared_state["my_job_url"] = unique_url


def test_jobs_list_my_contains_user_created_job_without_status(base_url, user_headers, shared_state):
    assert "my_job_id" in shared_state, "Missing shared_state['my_job_id']"
    job_id = shared_state["my_job_id"]

    url = f"{base_url}/api/jobs?category=my&sort=created_desc&limit=100&offset=0"
    r = requests.get(url, headers=user_headers)

    print("LIST MY Response:", r.status_code, r.text)
    assert r.status_code == 200, r.text

    payload = r.json()
    assert isinstance(payload, dict), "Response is not an envelope object"
    assert payload.get("category") == "my"
    assert "items" in payload, "Envelope missing 'items'"

    items = payload["items"]
    assert isinstance(items, list), "'items' must be a list"

    ids = [item.get("Id") for item in items if isinstance(item, dict)]
    assert job_id in ids, (
        "Job created by this user should appear in category=my even when user status is unset"
    )