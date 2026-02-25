def test_list_runs_pending(base_url, auth_headers, get_json):
    # First page
    url = f"{base_url}/api/enrichment/runs?status=Pending&limit=10&offset=0"
    r = get_json(url, auth_headers)
    assert r.status_code == 200, r.text

    data = r.json()
    assert "items" in data and isinstance(data["items"], list)
    assert data.get("status") in ("Pending", "pending", "PENDING")  # tolerate casing if you change later

    # Schema sanity on a sample item if any exist
    if data["items"]:
        it = data["items"][0]
        assert "runId" in it
        assert "status" in it
        assert it["status"] in ("Pending", "Queued")  # endpoint allows both, but query asked Pending

    assert "total" in data and isinstance(data["total"], int)
    assert "hasMore" in data and isinstance(data["hasMore"], bool)