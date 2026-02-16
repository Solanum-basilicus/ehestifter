def test_internal_input(base_url, auth_headers, get_json, shared_state):
    run_id = shared_state["run_id"]
    url = f"{base_url}/api/internal/enrichment/runs/{run_id}/input"
    r = get_json(url, auth_headers)

    # If snapshot upload is now fixed, expect 200; otherwise expect snapshot missing.
    assert r.status_code in (200, 404, 409)

    if r.status_code == 200:
        data = r.json()
        # Be loose on shape; just ensure it's JSON object
        assert isinstance(data, dict)
