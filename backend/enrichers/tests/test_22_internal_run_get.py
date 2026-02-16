def test_internal_run_get(base_url, auth_headers, get_json, shared_state):
    run_id = shared_state["run_id"]
    url = f"{base_url}/api/internal/enrichment/runs/{run_id}"
    r = get_json(url, auth_headers)
    assert r.status_code == 200
    data = r.json()
    assert data["runId"].lower() == run_id.lower()
    assert "leaseUntil" in data
    assert "inputSnapshotBlobPath" in data
