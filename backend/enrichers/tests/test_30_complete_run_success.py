def test_complete_run_success(base_url, auth_headers, post_json, shared_state):
    run_id = shared_state.get("run_id")
    assert run_id, "Missing run_id in shared_state"

    url = f"{base_url}/api/enrichment/runs/{run_id}/complete"

    payload = {
        "status": "Succeeded",
        "result": {
            "score": 8.5,
            "summary": "test summary",
            "debug": {"source": "pytest"},
        },
        "enrichmentAttributes": {
            "testAttr": True
        }
    }

    r = post_json(url, auth_headers, payload)
    assert r.status_code in (200, 204), r.text
