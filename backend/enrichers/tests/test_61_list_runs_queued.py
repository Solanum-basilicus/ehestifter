def test_list_runs_queued(base_url, auth_headers, get_json):
    url = f"{base_url}/api/enrichment/runs?status=Queued&limit=10&offset=0"
    r = get_json(url, auth_headers)
    assert r.status_code == 200, r.text

    data = r.json()
    assert "items" in data and isinstance(data["items"], list)
    assert data.get("status") in ("Queued", "queued", "QUEUED")

    if data["items"]:
        it = data["items"][0]
        assert "runId" in it
        assert it.get("status") in ("Queued", "Pending")
    
    assert "total" in data and isinstance(data["total"], int)
    assert "hasMore" in data and isinstance(data["hasMore"], bool)