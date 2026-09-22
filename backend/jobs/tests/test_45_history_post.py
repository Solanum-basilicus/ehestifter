# tests/test_45_history_post.py
import uuid

import requests


def test_history_post_system_actor_for_current_user(
    base_url, system_headers, user_headers, shared_state, test_user_id
):
    assert "job_id" in shared_state, "Job not created"
    job_id = shared_state["job_id"]
    url = f"{base_url}/api/jobs/{job_id}/history"
    expected_user_id = str(uuid.UUID(test_user_id))
    payload = {
        "action": "enrichment_finished",
        "details": {"userId": expected_user_id, "result": "test"},
    }
    r = requests.post(url, headers=system_headers, json=payload)
    print("Response text:", r.text, " with status ", r.status_code, end=" ")
    assert r.status_code == 200, r.text

    r2 = requests.get(f"{url}?limit=20", headers=user_headers)
    assert r2.status_code == 200
    items = r2.json().get("items", [])
    assert any(
        item.get("kind") == "enrichment_finished"
        and (item.get("data") or {}).get("userId") == expected_user_id
        for item in items
    )


def test_history_post_system_events_for_other_or_unknown_user_are_hidden(
    base_url, system_headers, user_headers, shared_state, test_user_id
):
    assert "job_id" in shared_state, "Job not created"
    job_id = shared_state["job_id"]
    url = f"{base_url}/api/jobs/{job_id}/history"
    expected_user_id = str(uuid.UUID(test_user_id))
    other_user_id = "11111111-2222-3333-4444-555555555555"
    assert other_user_id != expected_user_id
    marker = "unowned-system-note-from-test-suite"

    other_user_payload = {
        "action": "enrichment_finished",
        "details": {"userId": other_user_id, "result": "test"},
    }
    other_user_response = requests.post(
        url, headers=system_headers, json=other_user_payload
    )
    assert other_user_response.status_code == 200, other_user_response.text

    unknown_user_payload = {
        "action": "note_added",
        "details": {"text": marker},
    }
    unknown_user_response = requests.post(
        url, headers=system_headers, json=unknown_user_payload
    )
    print(
        "Response text:",
        unknown_user_response.text,
        " with status ",
        unknown_user_response.status_code,
        end=" ",
    )
    assert unknown_user_response.status_code == 200, unknown_user_response.text

    r = requests.get(f"{url}?limit=50", headers=user_headers)
    assert r.status_code == 200
    items = r.json().get("items", [])
    assert not any(
        (item.get("data") or {}).get("userId") == other_user_id for item in items
    )
    assert not any(
        (item.get("data") or {}).get("text") == marker for item in items
    )
