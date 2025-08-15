import pytest
import requests

def _assert_item_shape(item):
    assert "id" in item and isinstance(item["id"], str)
    assert "jobId" in item and isinstance(item["jobId"], str)
    assert "timestamp" in item and isinstance(item["timestamp"], str)
    assert "actorType" in item and item["actorType"] in ("user", "system")
    assert "kind" in item and isinstance(item["kind"], str)
    if item.get("data") is not None:
        assert isinstance(item["data"], dict)
    if item.get("v") is not None:
        assert isinstance(item["v"], int)

def _fetch_all_history(base_url, headers, job_id, page_limit=1, max_pages=10):
    url = f"{base_url}/api/jobs/{job_id}/history"
    cursor = None
    all_items = []
    for i in range(max_pages):
        params = {"limit": page_limit}
        if cursor:
            params["cursor"] = cursor
        r = requests.get(url, headers=headers, params=params)
        print(f"(HISTORY page{i+1}:", r.status_code, r.text[:300], ")", end="")
        assert r.status_code == 200
        payload = r.json()
        items = payload.get("items", [])
        for it in items:
            _assert_item_shape(it)
        all_items.extend(items)
        cursor = payload.get("nextCursor")
        if not cursor or not items:
            break
    return all_items

def test_07_get_history(base_url, auth_headers, shared_state):
    job_id = shared_state.get("job_id")
    assert job_id, "shared_state['job_id'] must be set by test_01_create_job"

    # Use limit=1 to exercise pagination; fetch up to 5 pages
    items = _fetch_all_history(base_url, auth_headers, job_id, page_limit=1, max_pages=5)

    # We expect at least the create entry to exist
    assert any(it.get("kind") == "job_created" for it in items), "Expected to find a 'job_created' history entry."

    # Optional order check (newest-first)
    ts_list = [it["timestamp"] for it in items]
    assert ts_list == sorted(ts_list, reverse=True), "History should be ordered newest-first by timestamp"
