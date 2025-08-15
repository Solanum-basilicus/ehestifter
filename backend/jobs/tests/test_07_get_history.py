import pytest
import requests

def _assert_item_shape(item):
    # Minimal shape checks for a history row from GET /jobs/{jobId}/history
    assert "id" in item and isinstance(item["id"], str)
    assert "jobId" in item and isinstance(item["jobId"], str)
    assert "timestamp" in item and isinstance(item["timestamp"], str)
    assert "actorType" in item and item["actorType"] in ("user", "system")
    assert "kind" in item and isinstance(item["kind"], str)
    # data can be None or dict depending on kind
    if item.get("data") is not None:
        assert isinstance(item["data"], dict)
    # v can be None or int (version)
    if item.get("v") is not None:
        assert isinstance(item["v"], int)

def test_07_get_history(base_url, auth_headers, shared_state):
    job_id = shared_state.get("job_id")
    assert job_id, "shared_state['job_id'] must be set by test_01_create_job"

    # Page 1 - request a small page to exercise pagination
    params = {"limit": 1}
    url = f"{base_url}/api/jobs/{job_id}/history"
    r1 = requests.get(url, headers=auth_headers, params=params)
    print("(HISTORY page1:", r1.status_code, r1.text[:300], ")", end="")
    assert r1.status_code == 200

    payload1 = r1.json()
    assert "items" in payload1 and isinstance(payload1["items"], list)
    assert len(payload1["items"]) <= 1
    if payload1["items"]:
        _assert_item_shape(payload1["items"][0])

    # If there is a next cursor, fetch the next page too
    all_items = list(payload1["items"])
    cursor = payload1.get("nextCursor")

    if cursor:
        r2 = requests.get(url, headers=auth_headers, params={"limit": 1, "cursor": cursor})
        print("(HISTORY page2:", r2.status_code, r2.text[:300], ")", end="")
        assert r2.status_code == 200
        payload2 = r2.json()
        assert "items" in payload2 and isinstance(payload2["items"], list)
        for it in payload2["items"]:
            _assert_item_shape(it)
        all_items.extend(payload2["items"])

    # We expect at least one history item by now (job_created)
    assert len(all_items) >= 1, "Expected at least one history item (job_created)."

    # Find the job_created entry and validate minimal data contract
    created = next((it for it in all_items if it.get("kind") == "job_created"), None)
    assert created is not None, "Expected to find a 'job_created' history entry."
    # For trimmed details, data contains only jobId
    data = created.get("data") or {}
    assert data.get("jobId") == job_id, "job_created.data.jobId should match created job_id"

    # Optional: check ordering is newest-first by timestamp (page boundary tolerant)
    # If we got 2 pages, the first item of page1 should be >= last item of page2 by timestamp.
    if len(all_items) >= 2:
        ts0 = all_items[0]["timestamp"]
        ts_last = all_items[-1]["timestamp"]
        assert ts0 >= ts_last, "History should be ordered newest-first by timestamp"
