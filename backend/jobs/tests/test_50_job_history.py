# tests/test_50_job_history.py
import uuid

import requests


def test_job_history_get_requires_user_id(base_url, auth_headers, shared_state):
    assert "job_id" in shared_state, "Job not created"
    job_id = shared_state["job_id"]
    url = f"{base_url}/api/jobs/{job_id}/history?limit=50"
    r = requests.get(url, headers=auth_headers)
    print("Response text:", r.text, " with status ", r.status_code, end=" ")
    assert r.status_code == 401, r.text


def test_job_history_get_hides_other_user_events_before_limit(
    base_url, auth_headers, user_headers, shared_state, test_user_id
):
    assert "job_id" in shared_state, "Job not created"
    job_id = shared_state["job_id"]
    url = f"{base_url}/api/jobs/{job_id}/history"
    expected_user_id = str(uuid.UUID(test_user_id))
    other_user_id = str(uuid.UUID("11111111-2222-3333-4444-555555555555"))
    assert other_user_id != expected_user_id

    other_headers = dict(auth_headers)
    other_headers["X-User-Id"] = other_user_id
    shared_marker = "shared-update-from-other-user"
    shared_payload = {
        "action": "job_updated",
        "details": {"testMarker": shared_marker},
    }
    shared_response = requests.post(url, headers=other_headers, json=shared_payload)
    assert shared_response.status_code == 200, shared_response.text

    own_headers = dict(auth_headers)
    own_headers["X-User-Id"] = expected_user_id
    own_payload = {
        "action": "status_changed",
        "details": {"userId": expected_user_id, "from": "Applied", "to": "Interested"},
    }
    own_response = requests.post(url, headers=own_headers, json=own_payload)
    assert own_response.status_code == 200, own_response.text

    other_payload = {
        "action": "status_changed",
        "details": {"userId": other_user_id, "from": "Unset", "to": "Rejected"},
    }
    other_response = requests.post(url, headers=other_headers, json=other_payload)
    assert other_response.status_code == 200, other_response.text

    first_page = requests.get(f"{url}?limit=1", headers=user_headers)
    print(
        "Response text:", first_page.text, " with status ", first_page.status_code, end=" "
    )
    assert first_page.status_code == 200, first_page.text
    first_items = first_page.json().get("items", [])
    assert len(first_items) == 1
    assert first_items[0].get("kind") == "status_changed"
    assert (first_items[0].get("data") or {}).get("userId") == expected_user_id

    full_page = requests.get(f"{url}?limit=50", headers=user_headers)
    assert full_page.status_code == 200, full_page.text
    items = full_page.json().get("items", [])
    assert any(item.get("kind") == "job_created" for item in items)
    assert any(
        item.get("kind") == "job_updated"
        and (item.get("data") or {}).get("testMarker") == shared_marker
        for item in items
    )
    assert any(
        item.get("kind") == "status_changed"
        and (item.get("data") or {}).get("userId") == expected_user_id
        for item in items
    )
    assert not any(
        (item.get("data") or {}).get("userId") == other_user_id for item in items
    )
