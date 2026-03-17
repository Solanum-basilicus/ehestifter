import requests


def _extract_ids(payload: dict) -> list[str]:
    items = payload.get("items", [])
    return [item.get("Id") for item in items if isinstance(item, dict)]


def test_jobs_list_all(base_url, user_headers, shared_state):
    assert "job_id" in shared_state, "Job not created"
    job_id = shared_state["job_id"]

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
        assert "locations" in items[0], "Locations array not present in response"

    ids = _extract_ids(payload)
    assert job_id in ids, "Job ID not found in category=all response"


def test_jobs_list_my_contains_created_job_even_without_status(base_url, user_headers, shared_state):
    assert "job_id" in shared_state, "Job not created"
    job_id = shared_state["job_id"]

    url = f"{base_url}/api/jobs?category=my&sort=created_desc&limit=50&offset=0"
    r = requests.get(url, headers=user_headers)

    print("Response text:", r.text, " with status ", r.status_code, end=" ")
    assert r.status_code == 200, r.text

    payload = r.json()
    assert isinstance(payload, dict), "Response is not an envelope object"
    assert payload.get("category") == "my"
    assert "items" in payload, "Envelope missing 'items'"

    ids = _extract_ids(payload)
    assert job_id in ids, (
        "Job created by this user should appear in category=my even when user status is unset"
    )
    