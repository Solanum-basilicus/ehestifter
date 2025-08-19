# tests/test_45_history_post.py
import requests

def test_history_post_system_actor(base_url, auth_headers, shared_state):
    assert "job_id" in shared_state, "Job not created"
    job_id = shared_state["job_id"]
    url = f"{base_url}/api/jobs/{job_id}/history"
    headers = dict(auth_headers)  # function key
    headers["X-Actor-Type"] = "system"
    payload = {
        "action": "note_added",
        "details": {"text": "system note from test suite"}
    }
    r = requests.post(url, headers=headers, json=payload)
    print("Response text:", r.text, " with status ", r.status_code, end=" ")
    assert r.status_code == 200, r.text

    # verify it shows up
    r2 = requests.get(f"{base_url}/api/jobs/{job_id}/history?limit=5", headers=auth_headers)
    assert r2.status_code == 200
    items = r2.json().get("items", [])
    assert any(i.get("kind") == "note_added" for i in items)
